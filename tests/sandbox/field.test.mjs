import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'near-workspaces';

const wasm = (name) => fileURLToPath(new URL(
  `../../contracts/target/wasm32-unknown-unknown/release/veilbound_${name}.wasm`, import.meta.url,
));
const previousCore = process.env.VEILBOUND_FIELD_PREVIOUS_CORE;

async function upgradePlan() {
  if (!previousCore) return null;
  const manifest = JSON.parse(await readFile(new URL(
    '../../deployments/field-rewards/testnet.upgrade.unsigned.json', import.meta.url,
  ), 'utf8'));
  const baseline = await readFile(previousCore);
  const sha256 = (code) => createHash('sha256').update(code).digest('hex');
  assert.equal(sha256(baseline), manifest.previousArtifacts.core.sha256);
  assert.equal(sha256(await readFile(wasm('copper'))), manifest.previousArtifacts.copper.sha256);
  const actions = manifest.batches.flatMap((batch) => batch.actions);
  const upgrade = actions.find((action) => action.params?.methodName === 'upgrade').params;
  assert.equal(sha256(Buffer.from(upgrade.args.wasm, 'base64')), manifest.artifacts.core.sha256);
  const pause = actions.find((action) => action.params?.methodName === 'set_paused').params;
  return { pause, upgrade };
}

test('Field reward escrow settles once against the operator’s existing Copper', async (t) => {
  const worker = await Worker.init();
  t.after(() => worker.tearDown());
  const root = worker.rootAccount;
  const copper = await root.createSubAccount('copper');
  const core = await root.createSubAccount('core');
  const operator = await root.createSubAccount('operator');
  const player = await root.createSubAccount('player');
  const gas = '60000000000000';
  const storage = { attachedDeposit: '100000000000000000000000' };
  await copper.deploy(wasm('copper'));
  const plan = await upgradePlan();
  await core.deploy(previousCore || wasm('core'));
  await root.call(copper, 'new', {
    owner_id: root.accountId, core_id: core.accountId, bootstrap_cap: '1000',
    global_reward_cap: '0', epoch_length_ns: '10000000000000000000', epoch_reward_cap: '0',
  });
  await root.call(core, 'new', {
    owner_id: root.accountId, copper_id: copper.accountId,
    receipt_signer: Buffer.alloc(32, 1).toString('base64'), ruleset: 'field-v1',
  });
  await operator.call(copper, 'storage_deposit', { registration_only: true }, storage);
  await operator.call(core, 'fund_storage', {}, storage);
  await root.call(copper, 'bootstrap', { claim_id: 'field-escrow', receiver_id: operator.accountId, amount: '100' });
  await operator.call(copper, 'ft_transfer_call', {
    receiver_id: core.accountId, amount: '100', msg: JSON.stringify({ operation_id: 'field-funding' }),
  }, { gas: '100000000000000', attachedDeposit: '1' });
  if (plan) {
    await root.call(core, 'set_paused', { paused: false });
    await root.call(core, 'register_item', { token_id: 'starter-salt', name: 'Salt', version: '1', bootstrap_cap: '1' });
    await root.call(core, 'bootstrap_item', { claim_id: 'starter-salt', receiver_id: root.accountId, token_id: 'starter-salt', amount: '1' });
    const starter = { copper: '10', token_ids: ['starter-salt'], quantities: ['1'], grant_cap: '1' };
    await root.call(core, 'configure_starter', { configuration: starter });
    const custodyState = async () => ({
      copper: await copper.view('ft_balance_of', { account_id: core.accountId }),
      total: await core.view('get_total_allocated'),
      balance: await core.view('get_balance', { account_id: operator.accountId }),
      operation: await core.view('get_operation', { operation_id: 'field-funding', account_id: operator.accountId, kind: 'deposit' }),
      storage: await core.view('get_storage_credit', { account_id: operator.accountId }),
      starter: await core.view('get_starter_configuration'),
      items: await core.view('mt_balance_of', { account_id: root.accountId, token_id: 'starter-salt' }),
    });
    const before = await custodyState();
    assert.equal(before.copper, '100');
    assert.equal(before.total, '100');
    assert.deepEqual(before.starter, starter);
    assert.equal(before.items, '1');
    await assert.rejects(core.view('get_field_reward_operator'));
    for (const action of [plan.pause, plan.upgrade]) {
      await root.call(core, action.methodName, action.args, { gas: action.gas, attachedDeposit: action.deposit });
    }
    assert.equal(await core.view('is_paused'), true);
    assert.deepEqual(await custodyState(), before);
    assert.equal(await core.view('get_field_reward_operator'), null);
  }
  await assert.rejects(player.call(core, 'set_field_reward_operator', { operator_id: player.accountId }));
  await root.call(core, 'set_field_reward_operator', { operator_id: operator.accountId });
  assert.equal(await core.view('get_field_reward_operator'), operator.accountId);
  await root.call(core, 'set_paused', { paused: false });
  const reserve = {
    operation_id: 'a'.repeat(64), beneficiary: player.accountId,
    amount: '40', expires_at_ns: ((BigInt(Date.now()) + 3_600_000n) * 1_000_000n).toString(),
  };
  const pay = { reservation_id: reserve.operation_id };
  const release = { reservation_id: 'b'.repeat(64) };
  const balance = (account) => core.view('get_balance', { account_id: account.accountId });
  await assert.rejects(player.call(core, 'reserve_field_reward', reserve, { gas }));
  assert.equal((await operator.call(core, 'reserve_field_reward', reserve, { gas })).status, 'reserved');
  await operator.call(core, 'reserve_field_reward', reserve, { gas });
  await assert.rejects(operator.call(core, 'reserve_field_reward', { ...reserve, amount: '41' }, { gas }));
  await assert.rejects(operator.call(core, 'reserve_field_reward', { ...reserve, operation_id: 'c'.repeat(64), amount: '61' }, { gas }));
  await assert.rejects(operator.call(core, 'reserve_field_reward', { ...reserve, operation_id: 'd'.repeat(64), expires_at_ns: '1' }, { gas }));
  await operator.call(core, 'reserve_field_reward', { ...reserve, operation_id: release.reservation_id, amount: '20' }, { gas });
  assert.deepEqual(await balance(operator), { available: '40', reserved: '60' });
  await assert.rejects(player.call(core, 'pay_field_reward', pay, { gas }));
  await assert.rejects(player.call(core, 'release_field_reward', release, { gas }));
  await root.call(core, 'set_paused', { paused: true });
  await assert.rejects(operator.call(core, 'reserve_field_reward', { ...reserve, operation_id: 'e'.repeat(64) }, { gas }));
  assert.equal((await operator.call(core, 'pay_field_reward', pay, { gas })).status, 'paid');
  assert.equal((await operator.call(core, 'pay_field_reward', pay, { gas })).status, 'paid');
  assert.equal((await operator.call(core, 'release_field_reward', release, { gas })).status, 'released');
  assert.equal((await operator.call(core, 'release_field_reward', release, { gas })).status, 'released');
  await assert.rejects(operator.call(core, 'pay_field_reward', release, { gas }));
  await assert.rejects(operator.call(core, 'release_field_reward', pay, { gas }));
  assert.deepEqual(await balance(operator), { available: '60', reserved: '0' });
  assert.deepEqual(await balance(player), { available: '40', reserved: '0' });
  assert.equal(await core.view('get_total_allocated'), '100');
  assert.equal(await copper.view('ft_balance_of', { account_id: core.accountId }), '100');
  assert.deepEqual(await core.view('get_field_reward', pay), {
    beneficiary: player.accountId, amount: '40', expires_at_ns: reserve.expires_at_ns,
    status: 'paid', operator_id: operator.accountId,
  });
});
