import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'near-workspaces';

const wasm = (name) => fileURLToPath(new URL(
  `../../contracts/target/wasm32-unknown-unknown/release/veilbound_${name}.wasm`, import.meta.url,
));
const oneYocto = { attachedDeposit: '1' };
const storageDeposit = { attachedDeposit: '100000000000000000000000' };

test('Copper sandbox executes bounded emission, transfers, refunds and idempotent custody burns', async (t) => {
  const worker = await Worker.init();
  t.after(() => worker.tearDown());
  const root = worker.rootAccount;
  const copper = await root.createSubAccount('copper');
  const core = await root.createSubAccount('core');
  const alice = await root.createSubAccount('alice');
  const bob = await root.createSubAccount('bob');
  await copper.deploy(wasm('copper'));
  const configuration = {
    owner_id: root.accountId, core_id: core.accountId, bootstrap_cap: '1000',
    global_reward_cap: '1000', epoch_length_ns: '10000000000000000000', epoch_reward_cap: '100',
  };
  await root.call(copper, 'new', configuration);
  await assert.rejects(root.call(copper, 'new', configuration));
  assert.equal((await copper.view('ft_metadata')).decimals, 2);
  assert.equal(await copper.view('ft_total_supply'), '0');
  await alice.call(copper, 'storage_deposit', { registration_only: true }, storageDeposit);
  await bob.call(copper, 'storage_deposit', { registration_only: true }, storageDeposit);
  const bootstrap = { claim_id: 'bootstrap-1', receiver_id: alice.accountId, amount: '400' };
  await root.call(copper, 'bootstrap', bootstrap);
  await root.call(copper, 'bootstrap', bootstrap);
  await assert.rejects(alice.call(copper, 'bootstrap', { ...bootstrap, claim_id: 'unauthorized' }));
  const reward = { claim_id: 'reward-1', amount: '50', epoch: '0' };
  await assert.rejects(core.call(copper, 'mint_reward', reward));
  await assert.rejects(alice.call(copper, 'mint_reward', reward));
  await core.call(copper, 'mint_reward', reward, storageDeposit);
  await core.call(copper, 'mint_reward', reward, storageDeposit);
  assert.equal((await copper.view('get_reward_budget')).epoch_minted, '50');
  await assert.rejects(core.call(copper, 'mint_reward', { ...reward, claim_id: 'reward-2', amount: '51' }, storageDeposit));
  await alice.call(copper, 'ft_transfer', { receiver_id: bob.accountId, amount: '25' }, oneYocto);
  await alice.call(copper, 'ft_transfer_call', {
    receiver_id: core.accountId, amount: '25', msg: 'receiver has no contract',
  }, { ...oneYocto, gas: '100000000000000' });
  assert.equal(await copper.view('ft_balance_of', { account_id: alice.accountId }), '375');
  assert.equal(await copper.view('ft_balance_of', { account_id: bob.accountId }), '25');
  assert.equal(await copper.view('ft_balance_of', { account_id: core.accountId }), '50');
  const burn = { operation_id: 'burn-1', amount: '10' };
  await assert.rejects(alice.call(copper, 'burn_custody', burn));
  await core.call(copper, 'burn_custody', burn);
  await core.call(copper, 'burn_custody', burn);
  assert.equal(await copper.view('ft_total_supply'), '440');
});
