import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'near-workspaces';

const wasm = (name) => fileURLToPath(new URL(
  `../../contracts/target/wasm32-unknown-unknown/release/veilbound_${name}.wasm`, import.meta.url,
));

test('Factory deploys a keyless vault and NFT transfer changes registry epoch', async (t) => {
  const worker = await Worker.init();
  t.after(() => worker.tearDown());
  const root = worker.rootAccount;
  const core = await root.createSubAccount('core');
  const copper = await root.createSubAccount('copper');
  const alice = await root.createSubAccount('alice');
  const bob = await root.createSubAccount('bob');
  await core.deploy(wasm('core'));
  await copper.deploy(wasm('copper'));
  await root.call(copper, 'new', {
    owner_id: root.accountId, core_id: core.accountId, bootstrap_cap: '20',
    global_reward_cap: '0', epoch_reward_cap: '0', epoch_length_ns: '10000000000000000000',
  });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  await root.call(core, 'new', {
    owner_id: root.accountId, copper_id: `copper.${root.accountId}`,
    receipt_signer: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'), ruleset: 'test-rules',
  });
  await root.call(core, 'set_paused', { paused: false });
  const code = await readFile(wasm('vault'));
  await root.call(core, 'pin_vault_template', { code_hash: createHash('sha256').update(code).digest('base64') });
  const args = {
    token_id: 'relic-1', owner_id: alice.accountId, kind: 'RELIC',
    metadata: { title: 'Starter Relic' }, vault_wasm: code.toString('base64'),
  };
  const gas = '150000000000000';
  const attachedDeposit = '3000000000000000000000000';
  await assert.rejects(bob.call(core, 'create_artifact', args, { gas, attachedDeposit }));
  const created = await root.call(core, 'create_artifact', args, { gas, attachedDeposit });
  assert.equal(created.status, 'ready');
  assert.equal(created.epoch, '0');
  const vault = core.getAccount(created.vault_id);
  assert.equal((await vault.view('get_identity')).token_id, 'relic-1');
  assert.deepEqual((await vault.viewAccessKeys(vault.accountId)).keys, []);
  assert.equal((await core.view('nft_token', { token_id: 'relic-1' })).owner_id, alice.accountId);
  const transfer = { token_id: 'relic-1', receiver_id: bob.accountId };
  const oneYocto = { attachedDeposit: '1', gas };
  await assert.rejects(bob.call(core, 'nft_transfer', { ...transfer, receiver_id: alice.accountId }, oneYocto));
  await alice.call(core, 'nft_transfer', transfer, oneYocto);
  assert.equal((await core.view('get_artifact', { token_id: 'relic-1' })).epoch, '1');
  assert.equal((await core.view('nft_token', { token_id: 'relic-1' })).owner_id, bob.accountId);
  const shop = await root.call(core, 'create_artifact', {
    ...args, token_id: 'shop-1', kind: 'SHOP_CHARTER',
  }, { gas, attachedDeposit });
  for (const holder of [alice, bob]) {
    await holder.call(core, 'fund_storage', {}, { attachedDeposit: '100000000000000000000000' });
  }
  await root.call(core, 'register_item', { token_id: 'salt', name: 'Salt', version: '1', bootstrap_cap: '4' });
  await root.call(core, 'bootstrap_item', { claim_id: 'shop-fixture', receiver_id: alice.accountId, token_id: 'salt', amount: '4' });
  await alice.call(core, 'fund_artifact', { token_id: 'shop-1', copper: '0', item_ids: ['salt'], amounts: ['4'] }, oneYocto);
  const order = { token_id: 'shop-1', expected_epoch: '0', order_id: 'sell-salt', side: 'Sell',
    item_id: 'salt', quantity: '4', price: '2', expires_at_ns: '9000000000000000000' };
  await assert.rejects(bob.call(core, 'place_shop_order', order, oneYocto));
  await alice.call(core, 'place_shop_order', order, oneYocto);
  await alice.call(core, 'place_shop_order', order, oneYocto);
  assert.equal(await core.view('get_shop_open_order_count', { token_id: 'shop-1' }), '1');
  assert.deepEqual(await core.view('get_item_balance', { account_id: shop.vault_id, token_id: 'salt' }),
    { available: '0', reserved: '4', pending: '0' });
  await assert.rejects(alice.call(core, 'list_nft', { token_id: 'shop-1', price: '100' }, oneYocto));
  await assert.rejects(alice.call(core, 'nft_transfer', { token_id: 'shop-1', receiver_id: bob.accountId }, oneYocto));
  const fill = { owner: shop.vault_id, order_id: 'sell-salt', quantity: '2', expected_version: '0' };
  await assert.rejects(alice.call(core, 'fill_market_order', fill, oneYocto));
  await bob.call(copper, 'storage_deposit', { registration_only: true }, { attachedDeposit: '100000000000000000000000' });
  await root.call(copper, 'bootstrap', { claim_id: 'shop-copper', receiver_id: bob.accountId, amount: '20' });
  await bob.call(copper, 'ft_transfer_call', { receiver_id: core.accountId, amount: '20',
    msg: JSON.stringify({ operation_id: 'shop-copper' }) }, oneYocto);
  await bob.call(core, 'fill_market_order', fill, oneYocto);
  assert.equal(await core.view('mt_balance_of', { account_id: bob.accountId, token_id: 'salt' }), '2');
  assert.deepEqual(await core.view('get_balance', { account_id: shop.vault_id }), { available: '3', reserved: '0' });
  assert.equal(await core.view('get_total_allocated'), '20');
  const cancellation = { token_id: 'shop-1', expected_epoch: '0', order_id: 'sell-salt' };
  await alice.call(core, 'cancel_shop_order', cancellation, oneYocto);
  await alice.call(core, 'cancel_shop_order', cancellation, oneYocto);
  assert.equal(await core.view('get_shop_open_order_count', { token_id: 'shop-1' }), '0');
  await alice.call(core, 'nft_transfer', { token_id: 'shop-1', receiver_id: bob.accountId }, oneYocto);
  await assert.rejects(alice.call(core, 'place_shop_order', { ...order, order_id: 'new-sale', expected_epoch: '1' }, oneYocto));
  await bob.call(core, 'place_shop_order', { ...order, order_id: 'new-sale', expected_epoch: '1', quantity: '2' }, oneYocto);
  await bob.call(core, 'fund_storage', {}, { attachedDeposit: '100000000000000000000000' });
  await bob.call(core, 'list_nft', { token_id: 'relic-1', price: '100000000000000000000000' }, oneYocto);
  await assert.rejects(bob.call(core, 'nft_transfer', { token_id: 'relic-1', receiver_id: alice.accountId }, oneYocto));
  await assert.rejects(alice.call(core, 'buy_nft', { token_id: 'relic-1', expected_epoch: '0' },
    { gas, attachedDeposit: '100000000000000000000000' }));
  await alice.call(core, 'buy_nft', { token_id: 'relic-1', expected_epoch: '1' },
    { gas, attachedDeposit: '100000000000000000000000' });
  assert.equal((await core.view('nft_token', { token_id: 'relic-1' })).owner_id, alice.accountId);
  assert.equal(await core.view('get_sale_credit', { account_id: bob.accountId }), '97500000000000000000000');
  await bob.call(core, 'withdraw_sale_credit', {}, oneYocto);
  assert.equal(await core.view('get_pending_sale_withdrawal', { account_id: bob.accountId }), null);
  assert.equal(await core.view('get_sale_credit', { account_id: bob.accountId }), '0');
  await alice.call(core, 'nft_transfer', { token_id: 'relic-1', receiver_id: bob.accountId }, oneYocto);
  await bob.call(core, 'nft_transfer_call', {
    token_id: 'relic-1', receiver_id: alice.accountId, msg: 'receiver has no contract',
  }, oneYocto);
  assert.equal((await core.view('get_artifact', { token_id: 'relic-1' })).epoch, '5');
  assert.equal((await core.view('nft_token', { token_id: 'relic-1' })).owner_id, bob.accountId);
  const chronicle = {
    network: 'testnet', contract: core.accountId, ruleset: 'test-rules', account_id: bob.accountId,
    run_id: 'signed-run', token_id: 'relic-1', artifact_epoch: '1', entry_id: 'first-clear',
    achievement: 'region-3-clear', expires_at_ns: '9000000000000000000',
  };
  const attest = (receipt) => ({
    receipt, signature: sign(null, Buffer.from(['VEILBOUND_CHRONICLE_V1', ...Object.values(receipt)].join('\n')), privateKey).toString('base64'),
  });
  await assert.rejects(alice.call(core, 'record_signed_chronicle', attest(chronicle), oneYocto));
  const current = { ...chronicle, artifact_epoch: '5' };
  const signed = attest(current);
  await assert.rejects(alice.call(core, 'record_signed_chronicle', { ...signed,
    receipt: { ...current, achievement: 'five-region-clear' } }, oneYocto));
  const recorded = await alice.call(core, 'record_signed_chronicle', signed, oneYocto);
  assert.equal(recorded.player, bob.accountId);
  assert.deepEqual(await alice.call(core, 'record_signed_chronicle', signed, oneYocto), recorded);
  await assert.rejects(alice.call(core, 'record_signed_chronicle', attest({ ...current, entry_id: 'duplicate' }), oneYocto));
});
