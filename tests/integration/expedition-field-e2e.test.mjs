import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { once } from 'node:events';
import test from 'node:test';
import { chooseJourneyIntent } from '../../scripts/simulate-gameplay.mjs';
import { openGuestSessions } from '../../server/src/auth/guest.mjs';
import { createFieldRewardFunder } from '../../server/src/chain/field.mjs';
import { openRunRewards, rewardMessage } from '../../server/src/economy/run-rewards.mjs';
import { createGameServer } from '../../server/src/http.mjs';
import { createFieldRoutes } from '../../server/src/orders/field-http.mjs';
import { openFieldContracts } from '../../server/src/orders/field.mjs';
import { openRuns } from '../../server/src/runs/service.mjs';

test('authoritative local Expedition clears an elite and a boss before paying Field and banking Copper', async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const sandbox = process.env.VEILBOUND_FIELD_LOCAL_SANDBOX === 'true' ? await openSandbox(t, publicKey) : null;
  const sessions = openGuestSessions(':memory:');
  const player = sessions.create();
  const beneficiary = sandbox?.player.accountId ?? 'player.demo.testnet';
  const origin = 'http://localhost:8787';
  const beneficiaryFor = id => id === player.playerId ? beneficiary : null;
  const claims = new Map();
  const coreId = sandbox?.core.accountId ?? 'core.demo.testnet';
  const operatorId = sandbox?.operator.accountId ?? 'operator.demo.testnet';
  const now = sandbox ? Date.now : () => 1_790_000_000_000;
  const rewards = openRunRewards(':memory:', {
    privateKey, contractId: coreId, ruleset: 'veilbound-v1', epoch: sandbox ? await sandbox.copper.view('current_epoch') : '1',
    epochEndsAtMs: now() + 300_000, runBudgetAtomic: '10000', totalBudgetAtomic: '10000',
    now, beneficiaryForPlayer: beneficiaryFor,
    readFinalClaim: async receipt => sandbox
      ? sandbox.core.view('get_operation', { operation_id: receipt.claim_id, account_id: beneficiary, kind: 'reward' })
      : claims.get(receipt.claim_id),
  });
  const runs = openRuns(':memory:', { rewards, entropy: () => createHash('sha256').update('five-region-2').digest() });
  const reservations = new Map();
  const paid = [];
  const funder = createFieldRewardFunder({
    coreId, operatorId, now, beneficiaryFor,
    readFinal: async id => {
      if (!sandbox) return reservations.has(id) ? { value: reservations.get(id), blockHash: 'local-field-finality' } : null;
      const block = await sandbox.worker.provider.block({ finality: 'final' });
      const result = await sandbox.worker.provider.query({
        request_type: 'call_function', block_id: block.header.hash, account_id: coreId,
        method_name: 'get_field_reward', args_base64: Buffer.from(JSON.stringify({ reservation_id: id })).toString('base64'),
      });
      return { value: JSON.parse(Buffer.from(result.result).toString()), blockHash: result.block_hash, finalizedAtNs: block.header.timestamp_nanosec };
    },
    async signAndSend({ signerId, transaction }) {
      const { methodName, args, gas, deposit } = transaction.actions[0].params;
      if (sandbox) {
        try {
          await sandbox.operator.call(sandbox.core, methodName, args, { gas, attachedDeposit: deposit });
        } catch (error) {
          t.diagnostic('Sandbox field submission failed: ' + error.message);
          throw error;
        }
        const reservationId = args.operation_id ?? args.reservation_id;
        const expected = methodName === 'pay_field_reward' ? 'paid' : 'reserved';
        for (let attempt = 0; attempt < 20; attempt++) {
          const result = await sandbox.worker.provider.query({
            request_type: 'call_function', finality: 'final', account_id: coreId,
            method_name: 'get_field_reward', args_base64: Buffer.from(JSON.stringify({ reservation_id: reservationId })).toString('base64'),
          });
          if (JSON.parse(Buffer.from(result.result).toString())?.status === expected) break;
          await setTimeout(250);
        }
        if (methodName === 'pay_field_reward') paid.push(args.reservation_id);
        return;
      }
      if (methodName === 'reserve_field_reward') {
        assert.equal(args.beneficiary, beneficiary);
        reservations.set(args.operation_id, { beneficiary: args.beneficiary, operator_id: signerId,
          amount: args.amount, expires_at_ns: args.expires_at_ns, status: 'reserved' });
      } else {
        assert.equal(methodName, 'pay_field_reward');
        reservations.get(args.reservation_id).status = 'paid';
        paid.push(args.reservation_id);
      }
    },
  });
  const field = openFieldContracts(':memory:', { runs, funder, now, offers: [
    { id: 'graft-watch', objective: 'graft', delivery: 'sanctum', rewardAtomic: '250', endsAt: now() + 300_000 },
  ] });
  const server = createGameServer({ sessions, runs, field: createFieldRoutes(field), origin, secureCookies: false });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  async function api(path, body, expected = 200) {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin, cookie: 'veilbound_guest=' + player.token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json();
    assert.equal(response.status, expected, JSON.stringify({ path, payload }));
    return payload;
  }
  try {
    let snapshot = await api('runs', { mode: 'expedition', talisman: 'gate', operationId: 'field-e2e-start' });
    const { runId } = snapshot;
    const fieldPath = 'field-contracts/run/' + runId;
    assert.equal((await api(fieldPath)).offers[0].id, 'graft-watch');
    const contract = await api('field-contracts/accept', { runId, offerId: 'graft-watch' });
    const deliver = 'field-contracts/' + contract.id + '/deliver';
    assert.equal(contract.status, 'accepted');
    assert.equal((await api(fieldPath)).contracts[0].id, contract.id);
    assert.equal((await api(fieldPath)).offers.length, 0);
    assert.equal((await api(deliver, {}, 409)).error, 'OBJECTIVE_INCOMPLETE');
    const bank = 'runs/' + runId + '/prepare-bank';
    assert.equal((await api(bank, { region: 1 }, 409)).error, 'BANK_NOT_READY');
    for (let step = 0; step < 350 && !snapshot.checkpoints.length && snapshot.lifecycle !== 'LOST'; step++) {
      const intent = chooseJourneyIntent(snapshot, { preferredNode: snapshot.state.node === 'road' ? 'cache' : 'graft' });
      snapshot = await api('runs/' + runId + '/actions', { expectedVersion: snapshot.version, operationId: 'field-e2e-' + step, intent });
    }
    assert.equal(snapshot.checkpoints[0]?.node, 'sanctum');
    const progress = runs.verifyProgress(player.playerId, runId);
    assert.ok(progress.observations.some(event => event.kind === 'encounter-clear' && event.node === 'graft'), JSON.stringify(progress.observations));
    let payout;
    const pollDelay = sandbox ? 250 : 20;
    const timeout = Date.now() + (sandbox ? 30_000 : 2_000);
    do {
      [payout] = (await api(fieldPath)).contracts;
      if (payout.status === 'paid') break;
      await setTimeout(pollDelay);
    } while (Date.now() < timeout);
    assert.equal(payout.status, 'paid');
    assert.equal(payout.receipt.beneficiary, beneficiary);
    assert.ok(payout.evidence.clearSequence < payout.evidence.checkpointSequence);
    assert.equal((await api(deliver, {})).status, 'paid');
    assert.deepEqual(paid, [contract.id]);
    const claim = await api(bank, { region: 1 });
    assert.equal(claim.status, 'prepared');
    assert.equal(claim.receipt.account_id, beneficiary);
    assert.equal(Number(claim.receipt.sequence), payout.evidence.checkpointSequence);
    assert.equal(verify(null, rewardMessage(claim.receipt), publicKey, Buffer.from(claim.signature, 'base64')), true);
    if (sandbox) {
      const { methodName, args, gas, deposit } = claim.transaction.actions[0].params;
      const before = await sandbox.core.view('get_balance', { account_id: beneficiary });
      assert.equal(before.available, '250');
      const operation = await sandbox.player.call(sandbox.core, methodName, args, { gas, attachedDeposit: deposit });
      assert.equal(operation.status, 'settled');
      const after = await sandbox.core.view('get_balance', { account_id: beneficiary });
      assert.equal(after.available, (250n + BigInt(claim.receipt.amount)).toString());
      t.diagnostic('Local NEAR sandbox credited ' + claim.receipt.amount + ' atomic Copper from checkpoint plus 250 from Field.');
    } else {
      claims.set(claim.receipt.claim_id, { status: 'settled', amount: claim.receipt.amount, receipt: claim.receipt });
    }
    assert.equal((await api(bank, { region: 1 })).status, 'settled');
    assert.equal((await api(fieldPath)).contracts[0].status, 'paid');
  } finally {
    await new Promise(resolve => server.close(resolve));
    field.close();
    runs.close();
    rewards.close();
    sessions.close();
  }
});



async function openSandbox(t, publicKey) {
  const { Worker } = await import('../sandbox/node_modules/near-workspaces/dist/index.js');
  const { KeyPair } = await import('../../server/node_modules/near-api-js/lib/index.js');
  const worker = await Worker.init({ network: 'sandbox', rm: true });
  t.after(() => worker.tearDown());
  const root = worker.rootAccount;
  async function account() {
    const key = KeyPair.fromRandom('ed25519');
    const id = Buffer.from(key.getPublicKey().data).toString('hex');
    await root.transfer(id, '10000000000000000000000000');
    const result = root.getAccount(id);
    await result.setKey(key);
    return result;
  }
  const core = await account();
  const operator = await account();
  const player = await account();
  const copper = await root.createSubAccount('copper');
  const wasm = name => fileURLToPath(new URL(
    '../../contracts/target/wasm32-unknown-unknown/release/veilbound_' + name + '.wasm', import.meta.url));
  await core.deploy(wasm('core'));
  await copper.deploy(wasm('copper'));
  await root.call(copper, 'new', {
    owner_id: root.accountId, core_id: core.accountId, bootstrap_cap: '1000',
    global_reward_cap: '10000', epoch_length_ns: '10000000000000000000', epoch_reward_cap: '10000',
  });
  await root.call(core, 'new', {
    owner_id: root.accountId, copper_id: copper.accountId,
    receipt_signer: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64'),
    ruleset: 'veilbound-v1',
  });
  const storage = { attachedDeposit: '100000000000000000000000' };
  await operator.call(copper, 'storage_deposit', { registration_only: true }, storage);
  for (const account of [operator, player]) await account.call(core, 'fund_storage', {}, storage);
  await root.call(copper, 'bootstrap', { claim_id: 'field-local-escrow', receiver_id: operator.accountId, amount: '1000' });
  await operator.call(copper, 'ft_transfer_call', {
    receiver_id: core.accountId, amount: '1000', msg: JSON.stringify({ operation_id: 'field-local-funding' }),
  }, { gas: '100000000000000', attachedDeposit: '1' });
  await root.call(core, 'set_field_reward_operator', { operator_id: operator.accountId });
  await root.call(core, 'set_paused', { paused: false });
  return { worker, core, copper, operator, player };
}

