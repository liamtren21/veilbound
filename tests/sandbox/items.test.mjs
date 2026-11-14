import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'near-workspaces';

const coreWasm = fileURLToPath(new URL(
  '../../contracts/target/wasm32-unknown-unknown/release/veilbound_core.wasm', import.meta.url,
));

test('multi-token sandbox blocks overspend, resolves a failed receiver and consumes a reservation once', async (t) => {
  const worker = await Worker.init();
  t.after(() => worker.tearDown());
  const root = worker.rootAccount;
  const core = await root.createSubAccount('core');
  const alice = await root.createSubAccount('alice');
  const bob = await root.createSubAccount('bob');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  await core.deploy(coreWasm);
  await root.call(core, 'new', {
    owner_id: root.accountId, copper_id: `copper.${root.accountId}`,
    receipt_signer: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64'), ruleset: 'test-rules',
  });
  await root.call(core, 'set_paused', { paused: false });
  const gas = '100000000000000';
  const oneYocto = { gas, attachedDeposit: '1' };
  await alice.call(core, 'fund_storage', {}, { attachedDeposit: '100000000000000000000000' });
  await root.call(core, 'register_item', { token_id: 'salt', name: 'Salt', version: '1', bootstrap_cap: '10' });
  const bootstrap = { claim_id: 'grant-1', receiver_id: alice.accountId, token_id: 'salt', amount: '10' };
  await root.call(core, 'bootstrap_item', bootstrap);
  await root.call(core, 'bootstrap_item', bootstrap);
  await assert.rejects(alice.call(core, 'bootstrap_item', { ...bootstrap, claim_id: 'forged' }));
  const balance = (account) => core.view('mt_balance_of', { account_id: account.accountId, token_id: 'salt' });
  await alice.call(core, 'reserve_items', { reservation_id: 'run-1', token_ids: ['salt'], amounts: ['5'] }, oneYocto);
  await assert.rejects(alice.call(core, 'mt_transfer', { receiver_id: bob.accountId, token_id: 'salt', amount: '6' }, oneYocto));
  await assert.rejects(alice.call(core, 'mt_batch_transfer', {
    receiver_id: bob.accountId, token_ids: ['salt', 'salt'], amounts: ['1', '1'],
  }, oneYocto));
  const used = await alice.call(core, 'mt_transfer_call', {
    receiver_id: bob.accountId, token_id: 'salt', amount: '3', msg: 'receiver missing',
  }, oneYocto);
  assert.deepEqual(used, ['0']);
  assert.equal(await balance(alice), '10');
  assert.equal(await balance(bob), '0');
  await alice.call(core, 'mt_transfer', { receiver_id: bob.accountId, token_id: 'salt', amount: '3' }, oneYocto);
  const settlement = { account_id: alice.accountId, reservation_id: 'run-1', consumed: ['2'] };
  await assert.rejects(bob.call(core, 'settle_item_use', settlement));
  await root.call(core, 'settle_item_use', settlement);
  await root.call(core, 'settle_item_use', settlement);
  assert.equal(await balance(alice), '5');
  assert.equal(await balance(bob), '3');
  assert.equal(await core.view('mt_supply', { token_id: 'salt' }), '8');
  const reservation = { network: 'testnet', contract: core.accountId, ruleset: 'test-rules', account_id: alice.accountId,
    run_id: 'signed-run', reservation_id: 'signed-reserve', token_ids: ['salt'], amounts: ['2'], reserve_sequence: '1',
    expires_at_ns: String(BigInt(Date.now() + 3600000) * 1000000n) };
  const fields = [reservation.network, reservation.contract, reservation.ruleset, reservation.account_id,
    reservation.run_id, reservation.reservation_id, JSON.stringify(reservation.token_ids), JSON.stringify(reservation.amounts),
    reservation.reserve_sequence, reservation.expires_at_ns];
  const signature = (tag, suffix = []) => sign(null, Buffer.from([tag, ...fields, ...suffix].join('\n')), privateKey).toString('base64');
  const reserve = { receipt: reservation, signature: signature('VEILBOUND_RUN_ITEMS_RESERVE_V1') };
  await assert.rejects(bob.call(core, 'reserve_run_items', reserve, oneYocto));
  await alice.call(core, 'reserve_run_items', reserve, oneYocto);
  await assert.rejects(root.call(core, 'settle_item_use', { ...settlement, reservation_id: 'signed-reserve' }));
  const close = { receipt: { reservation, consumed: ['1'], close_sequence: '2' },
    signature: signature('VEILBOUND_RUN_ITEMS_CLOSE_V1', ['["1"]', '2']) };
  await assert.rejects(bob.call(core, 'close_run_items', { ...close, receipt: { ...close.receipt, consumed: ['0'] } }));
  await bob.call(core, 'close_run_items', close);
  await bob.call(core, 'close_run_items', close);
  assert.equal(await balance(alice), '4');
  assert.equal(await core.view('mt_supply', { token_id: 'salt' }), '7');
});
