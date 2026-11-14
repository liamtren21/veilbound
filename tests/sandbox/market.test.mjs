import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'near-workspaces';
const wasm = name => fileURLToPath(new URL('../../contracts/target/wasm32-unknown-unknown/release/veilbound_' + name + '.wasm', import.meta.url));

test('funded market partially fills and cancellation refunds only the remaining escrow', async t => {
  const worker = await Worker.init();
  t.after(() => worker.tearDown());
  const root = worker.rootAccount;
  const copper = await root.createSubAccount('copper');
  const core = await root.createSubAccount('core');
  const seller = await root.createSubAccount('seller');
  const gas = '150000000000000';
  const one = { gas, attachedDeposit: '1' };
  await copper.deploy(wasm('copper'));
  await core.deploy(wasm('core'));
  await root.call(copper, 'new', { owner_id: root.accountId, core_id: core.accountId,
    bootstrap_cap: '1000', global_reward_cap: '1000', epoch_length_ns: '10000000000000000000', epoch_reward_cap: '1000' });
  await root.call(core, 'new', { owner_id: root.accountId, copper_id: copper.accountId,
    receipt_signer: Buffer.alloc(32, 1).toString('base64'), ruleset: 'market-v1' });
  const storage = { attachedDeposit: '100000000000000000000000' };
  await root.call(core, 'fund_storage', {}, storage);
  await seller.call(core, 'fund_storage', {}, storage);
  await root.call(copper, 'storage_deposit', { registration_only: true }, storage);
  await root.call(copper, 'bootstrap', { claim_id: 'market-pool', receiver_id: root.accountId, amount: '1000' });
  await root.call(copper, 'ft_transfer_call', { receiver_id: core.accountId, amount: '1000',
    msg: JSON.stringify({ operation_id: 'deposit' }) }, one);
  await root.call(core, 'set_paused', { paused: false });
  await root.call(core, 'register_item', { token_id: 'salt', name: 'Salt', version: '1', bootstrap_cap: '10' });
  await root.call(core, 'bootstrap_item', { claim_id: 'salt-pool', receiver_id: seller.accountId, token_id: 'salt', amount: '10' });
  const buy = { order_id: 'buy-salt', side: 'Buy', token_id: 'salt', quantity: '10', price: '20', expires_at_ns: '9000000000000000000' };
  await root.call(core, 'place_market_order', buy, one);
  await root.call(core, 'place_market_order', buy, one);
  assert.deepEqual(await core.view('get_balance', { account_id: root.accountId }), { available: '800', reserved: '200' });
  const fill = { owner: root.accountId, order_id: 'buy-salt', quantity: '4', expected_version: '0' };
  await seller.call(core, 'fill_market_order', fill, one);
  await assert.rejects(seller.call(core, 'fill_market_order', fill, one));
  assert.deepEqual(await core.view('get_balance', { account_id: seller.accountId }), { available: '77', reserved: '0' });
  await root.call(core, 'cancel_market_order', { order_id: 'buy-salt' }, one);
  await root.call(core, 'cancel_market_order', { order_id: 'buy-salt' }, one);
  assert.deepEqual(await core.view('get_balance', { account_id: root.accountId }), { available: '923', reserved: '0' });
  assert.equal(await core.view('mt_balance_of', { account_id: root.accountId, token_id: 'salt' }), '4');
  const sell = { order_id: 'sell-salt', side: 'Sell', token_id: 'salt', quantity: '6', price: '20', expires_at_ns: '9000000000000000000' };
  await seller.call(core, 'place_market_order', sell, one);
  await root.call(core, 'fill_market_order', { owner: seller.accountId, order_id: 'sell-salt', quantity: '2', expected_version: '0' }, one);
  await seller.call(core, 'cancel_market_order', { order_id: 'sell-salt' }, one);
  assert.equal(await core.view('mt_balance_of', { account_id: seller.accountId, token_id: 'salt' }), '4');
  assert.deepEqual(await core.view('get_balance', { account_id: root.accountId }), { available: '885', reserved: '0' });
  assert.equal(await core.view('get_total_allocated'), '1000');
  await root.call(core, 'register_item', { token_id: 'ward', name: 'Ward', version: '1', bootstrap_cap: '1' });
  await root.call(core, 'register_recipe', { recipe_id: 'salt-ward-v1', recipe: {
    input_ids: ['salt'], input_amounts: ['2'], output_id: 'ward', output_amount: '1', copper_cost: '10',
  } });
  const craft = { operation_id: 'craft-1', recipe_id: 'salt-ward-v1' };
  await seller.call(core, 'craft_item', craft, one);
  await seller.call(core, 'craft_item', craft, one);
  assert.equal(await core.view('mt_balance_of', { account_id: seller.accountId, token_id: 'salt' }), '2');
  assert.equal(await core.view('mt_balance_of', { account_id: seller.accountId, token_id: 'ward' }), '1');
  assert.deepEqual(await core.view('get_balance', { account_id: seller.accountId }), { available: '105', reserved: '0' });
  assert.equal(await core.view('get_total_allocated'), '1000');
  const commissioned = { order_id: 'commission-1', recipe_id: 'salt-ward-v1', worker: root.accountId,
    wage: '5', deadline: '9000000000000000000' };
  await seller.call(core, 'place_craft_order', commissioned, one);
  await assert.rejects(seller.call(core, 'fulfill_craft_order', { buyer: seller.accountId, order_id: 'commission-1' }, one));
  await root.call(core, 'fulfill_craft_order', { buyer: seller.accountId, order_id: 'commission-1' }, one);
  await root.call(core, 'fulfill_craft_order', { buyer: seller.accountId, order_id: 'commission-1' }, one);
  assert.equal(await core.view('mt_balance_of', { account_id: seller.accountId, token_id: 'ward' }), '2');
  assert.deepEqual(await core.view('get_balance', { account_id: seller.accountId }), { available: '90', reserved: '0' });
});
