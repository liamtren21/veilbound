import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { generateMap } from '../../shared/map-generator.mjs';
import { bootstrapFieldContracts } from '../../server/src/orders/field-bootstrap.mjs';
import { createFieldRoutes } from '../../server/src/orders/field-http.mjs';
import { openGuestSessions } from '../../server/src/auth/guest.mjs';
import { createGameServer } from '../../server/src/http.mjs';

test('Field HTTP pays a verified linked wallet from finalized Core records and rejects borrowed evidence', async () => {
  const sessions = openGuestSessions(':memory:');
  const alice = sessions.create();
  const bob = sessions.create();
  const origin = 'http://localhost:8787';
  const calls = [];
  const rows = new Map();
  const graph = generateMap(1);
  let now = 100;
  let proof = { runId: 'run-1', mode: 'expedition', version: 1, graph, state: { phase: 'map', node: 'cache' }, observations: [] };
  const runs = { verifyProgress(player, runId) {
    if (player !== alice.playerId || runId !== 'run-1') throw Object.assign(new Error(), { status: 404, code: 'RUN_NOT_FOUND' });
    return proof;
  } };
  const env = {
    VEILBOUND_CORE_ID: 'core.demo.testnet', VEILBOUND_FIELD_OPERATOR_ID: 'operator.demo.testnet',
    VEILBOUND_FIELD_OPERATOR_KEY_PATH: 'scoped-key-fixture', VEILBOUND_FIELD_OFFERS_PATH: 'offer-fixture',
  };
  assert.equal(await bootstrapFieldContracts({ env: {}, file: ':memory:', runs }), undefined);
  const field = await bootstrapFieldContracts({
    env, file: ':memory:', runs, now: () => now,
    beneficiaryFor: player => player === alice.playerId ? 'alice.demo.testnet' : null,
    loadOffers: async () => JSON.stringify([{ id: 'graft-watch', objective: 'graft', delivery: 'sanctum', rewardAtomic: '250', endsAt: 200 }]),
    openOperator: async () => ({
      readFinal: async reservationId => rows.has(reservationId) ? { value: rows.get(reservationId), blockHash: 'final-block' } : null,
      async signAndSend({ signerId, transaction }) {
        assert.equal(signerId, env.VEILBOUND_FIELD_OPERATOR_ID);
        assert.equal(transaction.receiverId, env.VEILBOUND_CORE_ID);
        const { methodName, args } = transaction.actions[0].params;
        calls.push(methodName);
        if (methodName === 'reserve_field_reward') rows.set(args.operation_id, {
          beneficiary: args.beneficiary, operator_id: signerId, amount: args.amount, expires_at_ns: args.expires_at_ns, status: 'reserved',
        });
        else rows.get(args.reservation_id).status = methodName === 'pay_field_reward' ? 'paid' : 'released';
        if (methodName === 'pay_field_reward') throw new Error('rpc_timeout_after_execution');
      },
    }),
  });
  const server = createGameServer({ sessions, runs, field: createFieldRoutes(field), origin, secureCookies: false });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const request = (player, suffix = '', body) => fetch('http://127.0.0.1:' + server.address().port + '/api/field-contracts' + suffix, {
    method: body ? 'POST' : 'GET',
    headers: { origin, cookie: 'veilbound_guest=' + player.token, 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  try {
    assert.equal((await (await request(alice)).json()).offers.length, 1);
    assert.equal((await request(alice, '/accept', { runId: 'run-1', offerId: 'graft-watch', amountAtomic: '100000' })).status, 400);
    assert.equal((await request(bob, '/accept', { runId: 'run-1', offerId: 'graft-watch' })).status, 404);
    const accepted = await (await request(alice, '/accept', { runId: 'run-1', offerId: 'graft-watch' })).json();
    assert.equal(accepted.reservation.beneficiary, 'alice.demo.testnet');
    assert.equal((await request(bob, '/' + accepted.id)).status, 404);
    assert.equal((await request(alice, '/' + accepted.id + '/deliver', { sequence: 1 })).status, 400);
    proof = { ...proof, version: 5, observations: [
      { sequence: 2, kind: 'encounter-clear', node: 'graft' },
      { sequence: 5, kind: 'checkpoint', node: 'sanctum' },
    ] };
    const paid = await (await request(alice, '/' + accepted.id + '/deliver', {})).json();
    assert.equal(paid.status, 'paid');
    assert.equal(paid.receipt.blockHash, 'final-block');
    assert.deepEqual(calls, ['reserve_field_reward', 'pay_field_reward']);
    now = 200;
    assert.equal((await (await request(alice)).json()).offers.length, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    field.close();
    sessions.close();
  }
});


test('Field funder waits for a finalized block past expiry before releasing a pending payment', async () => {
  const { createFieldRewardFunder } = await import('../../server/src/chain/field.mjs');
  const id = 'f'.repeat(64);
  let timestamp = '199000000';
  const calls = [];
  const row = { beneficiary: 'alice.demo.testnet', amount: '250', expires_at_ns: '200000000',
    operator_id: 'operator.demo.testnet', status: 'reserved' };
  const funder = createFieldRewardFunder({
    coreId: 'core.demo.testnet', operatorId: 'operator.demo.testnet', now: () => 200,
    beneficiaryFor: () => row.beneficiary,
    readFinal: async () => ({ value: row, blockHash: 'final-block', finalizedAtNs: timestamp }),
    signAndSend: async request => {
      calls.push(request.transaction.actions[0].params.methodName);
      row.status = 'released';
    },
  });
  const intent = {
    reservationId: id, operationId: id + ':pay', accountId: 'alice', amountAtomic: '250', endsAt: 200,
    reservation: { beneficiary: row.beneficiary },
    evidence: { clearSequence: 2, checkpointSequence: 5, tradable: false },
  };
  await assert.rejects(funder.pay(intent), /settlement_pending/);
  timestamp = '200000000';
  await assert.rejects(funder.pay(intent), /payment_expired/);
  assert.deepEqual(calls, []);
  assert.equal((await funder.release({ ...intent, operationId: id + ':release' })).status, 'final');
  assert.deepEqual(calls, ['release_field_reward']);
});


