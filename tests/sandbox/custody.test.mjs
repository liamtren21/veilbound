import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'near-workspaces';

const wasm = (name) => fileURLToPath(new URL(
  `../../contracts/target/wasm32-unknown-unknown/release/veilbound_${name}.wasm`, import.meta.url,
));
const gas = '100000000000000';
const oneYocto = { gas, attachedDeposit: '1' };

test('Core deposits, withdraws, refunds and credits only confirmed signed rewards', async (t) => {
  const worker = await Worker.init();
  t.after(() => worker.tearDown());
  const root = worker.rootAccount;
  const copper = await root.createSubAccount('copper');
  const core = await root.createSubAccount('core');
  const alice = await root.createSubAccount('alice');
  const bob = await root.createSubAccount('bob');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const signer = publicKey.export({ format: 'jwk' }).x;
  const receiptSigner = Buffer.from(signer, 'base64url').toString('base64');
  await copper.deploy(wasm('copper'));
  await core.deploy(wasm('core'));
  await root.call(copper, 'new', {
    owner_id: root.accountId, core_id: core.accountId, bootstrap_cap: '1000',
    global_reward_cap: '1000', epoch_length_ns: '10000000000000000000', epoch_reward_cap: '100',
  });
  await root.call(core, 'new', {
    owner_id: root.accountId, copper_id: copper.accountId, receipt_signer: receiptSigner, ruleset: 'test-rules',
  });
  assert.deepEqual(await core.view('get_reward_config'), {
    receipt_signer: receiptSigner, ruleset: 'test-rules', copper_id: copper.accountId,
  });
  assert.equal(await core.view('is_paused'), true);
  const storageDeposit = { attachedDeposit: '100000000000000000000000' };
  await alice.call(copper, 'storage_deposit', { registration_only: true }, storageDeposit);
  for (const player of [alice, bob]) await player.call(core, 'fund_storage', {}, storageDeposit);
  await root.call(copper, 'bootstrap', { claim_id: 'bootstrap-1', receiver_id: alice.accountId, amount: '400' });
  const callDeposit = (msg) => alice.call(copper, 'ft_transfer_call', {
    receiver_id: core.accountId, amount: '100', msg,
  }, oneYocto);
  assert.equal(await callDeposit('invalid'), '0');
  const validDeposit = JSON.stringify({ operation_id: 'deposit-1' });
  assert.equal(await callDeposit(validDeposit), '100');
  assert.equal(await callDeposit(validDeposit), '0');
  assert.equal(await alice.call(core, 'ft_on_transfer', {
    sender_id: alice.accountId, amount: '20', msg: JSON.stringify({ operation_id: 'forged' }),
  }), '20');
  await assert.rejects(alice.call(core, 'withdraw', { operation_id: 'paused', amount: '1' }, oneYocto));
  await assert.rejects(alice.call(core, 'on_withdrawal', { account_id: alice.accountId, operation_id: 'forged' }));
  await root.call(core, 'set_paused', { paused: false });
  const withdrawal = { operation_id: 'withdraw-1', amount: '30' };
  assert.equal((await alice.call(core, 'withdraw', withdrawal, oneYocto)).status, 'settled');
  assert.equal((await alice.call(core, 'withdraw', withdrawal, oneYocto)).status, 'settled');

  const receiptFor = (account, claimId, sequence) => ({
    network: 'testnet', contract: core.accountId, ruleset: 'test-rules', account_id: account.accountId,
    run_id: 'run-1', encounter_id: 'boss-1', sequence, claim_id: claimId, amount: '25',
    epoch: '0', expires_at_ns: '2000000000000000000',
  });
  const signature = (receipt) => sign(null, Buffer.from(
    ['VEILBOUND_REWARD_V1', ...Object.values(receipt)].join('\n'),
  ), privateKey).toString('base64');
  const aliceReceipt = receiptFor(alice, 'reward-1', '1');
  await assert.rejects(alice.call(core, 'claim_reward', {
    receipt: { ...aliceReceipt, amount: '26' }, signature: signature(aliceReceipt),
  }, { gas }));
  assert.equal((await alice.call(core, 'claim_reward', {
    receipt: aliceReceipt, signature: signature(aliceReceipt),
  }, { gas })).status, 'settled');
  const bobReceipt = receiptFor(bob, 'reward-2', '2');
  assert.equal((await bob.call(core, 'claim_reward', {
    receipt: bobReceipt, signature: signature(bobReceipt),
  }, { gas })).status, 'settled');
  const rejectedWithdrawal = { operation_id: 'withdraw-2', amount: '25' };
  assert.equal((await bob.call(core, 'withdraw', rejectedWithdrawal, oneYocto)).status, 'refunded');
  assert.equal((await bob.call(core, 'withdraw', rejectedWithdrawal, oneYocto)).status, 'refunded');
  assert.deepEqual(await core.view('get_balance', { account_id: alice.accountId }), { available: '95', reserved: '0' });
  assert.deepEqual(await core.view('get_balance', { account_id: bob.accountId }), { available: '25', reserved: '0' });
  assert.equal(await core.view('get_total_allocated'), '120');
  assert.equal(await copper.view('ft_balance_of', { account_id: core.accountId }), '120');
  await alice.call(copper, 'ft_transfer_call', { receiver_id: core.accountId, amount: '100',
    msg: JSON.stringify({ operation_id: 'purse-deposit' }) }, oneYocto);
  const reservation = { network: 'testnet', contract: core.accountId, ruleset: 'test-rules', account_id: alice.accountId,
    run_id: 'purse-run', amount: '100', expires_at_ns: String(BigInt(Date.now() + 3600000) * 1000000n) };
  const purseSignature = (tag, suffix = []) => sign(null, Buffer.from([tag, ...Object.values(reservation), ...suffix].join('\n')), privateKey).toString('base64');
  await alice.call(core, 'reserve_run_purse', { receipt: reservation, signature: purseSignature('VEILBOUND_RUN_PURSE_RESERVE_V1') }, oneYocto);
  const receipt = { reservation, sequence: '3', returned: '20', spent: '30', lost: '50' };
  const args = { receipt, signature: purseSignature('VEILBOUND_RUN_PURSE_CLOSE_V1', ['3', '20', '30', '50']) };
  assert.equal((await alice.call(core, 'close_run_purse', args, { gas })).settled, true);
  assert.equal((await alice.call(core, 'close_run_purse', args, { gas })).settled, true);
  assert.deepEqual(await core.view('get_balance', { account_id: alice.accountId }), { available: '115', reserved: '0' });
  assert.equal(await core.view('get_total_allocated'), '170');
  assert.equal(await copper.view('ft_balance_of', { account_id: core.accountId }), '170');
});
