import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openRunRewards, rewardMessage } from '../../server/src/economy/run-rewards.mjs';
import { openRuns } from '../../server/src/runs/service.mjs';

test('checkpoint settlement uses finalized chain state and retries only the existing operation', async () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  let operation;
  const rewards = openRunRewards(':memory:', {
    privateKey, contractId: 'core.vibebound.testnet', ruleset: 'veilbound-v1', epoch: '1',
    epochEndsAtMs: 2000, runBudgetAtomic: '10000', totalBudgetAtomic: '10000',
    now: () => 1000, beneficiaryForPlayer: () => 'alice.testnet', readFinalClaim: async () => operation,
  });
  try {
    rewards.reserve('alice', 'run-1');
    const claim = rewards.prepare('alice', { mode: 'expedition', runId: 'run-1',
      checkpoints: [{ region: 1, node: 'sanctum', copperAtomic: '1500' }], checkpointSequences: [45],
    }, 1);
    assert.deepEqual(await rewards.reconcile(claim), claim);
    operation = { status: 'pending', amount: '1500', receipt: claim.receipt };
    assert.equal((await rewards.reconcile(claim)).transaction.actions[0].params.methodName, 'retry_settlement');
    operation.status = 'settled';
    assert.deepEqual(await rewards.reconcile(claim), { status: 'settled', receipt: claim.receipt });
    operation.amount = '1501';
    await assert.rejects(rewards.reconcile(claim), { code: 'REWARD_SETTLEMENT_MISMATCH' });
  } finally { rewards.close(); }
});

test('new finalized epochs release only unsigned quota and preserve issued receipts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'veilbound-release-'));
  const file = join(directory, 'rewards.sqlite');
  const { privateKey } = generateKeyPairSync('ed25519');
  const options = { privateKey, contractId: 'core.vibebound.testnet', ruleset: 'veilbound-v1', epoch: '1',
    epochEndsAtMs: 2000, runBudgetAtomic: '10000', totalBudgetAtomic: '10000',
    now: () => 1000, beneficiaryForPlayer: () => 'alice.testnet' };
  const old = openRunRewards(file, options);
  let next;
  try {
    old.reserve('alice', 'run-1');
    const evidence = { mode: 'expedition', runId: 'run-1', checkpoints: [
      { region: 1, node: 'sanctum', copperAtomic: '1500' },
      { region: 2, node: 'belfry', copperAtomic: '1500' },
    ], checkpointSequences: [10, 20] };
    const claim = old.prepare('alice', evidence, 1);
    next = openRunRewards(file, { ...options, epoch: '2', finalizedEpoch: '2',
      epochEndsAtMs: 3000, now: () => 2100, runBudgetAtomic: '8500' });
    assert.equal(next.reserve('alice', 'run-2').maximumAtomic, '8500');
    assert.throws(() => next.reserve('alice', 'run-3'), { code: 'REWARD_BUDGET_EXHAUSTED' });
    assert.deepEqual(next.prepare('alice', evidence, 1), claim);
    assert.throws(() => old.prepare('alice', evidence, 2), { code: 'REWARD_EPOCH_CLOSED' });
  } finally {
    next?.close();
    old.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reward reservations are durable, bounded and bind only verified beneficiaries', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'veilbound-rewards-'));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const options = {
    privateKey, contractId: 'core.vibebound.testnet', ruleset: 'veilbound-v1', epoch: '1',
    epochEndsAtMs: 2000, runBudgetAtomic: '10000', totalBudgetAtomic: '10000',
    now: () => 1000, beneficiaryForPlayer: player => player === 'alice' ? 'alice.testnet' : null,
  };
  let rewards = openRunRewards(join(directory, 'rewards.sqlite'), options);
  const runs = openRuns(':memory:', { rewards });
  try {
    assert.throws(() => runs.start('bob', { mode: 'expedition', operationId: 'start' }), { code: 'WALLET_REQUIRED' });
    const start = runs.start('alice', { mode: 'expedition', operationId: 'start' });
    assert.equal(start.mode, 'expedition');
    assert.equal(start.rewardReservation.maximumAtomic, '10000');
    assert.deepEqual(runs.start('alice', { mode: 'expedition', operationId: 'start' }), start);
    assert.throws(() => rewards.reserve('alice', 'other-run'), { code: 'REWARD_BUDGET_EXHAUSTED' });
    await assert.rejects(runs.prepareBank('alice', start.runId, 1), { code: 'BANK_NOT_READY' });
    assert.throws(() => runs.start('alice', { mode: 'expedition', tutorial: true }), { code: 'INVALID_LOADOUT' });
    const evidence = { runId: start.runId, mode: 'expedition', checkpoints: [
      { region: 1, node: 'sanctum', copperAtomic: '1500' },
      { region: 2, node: 'drowned-belfry', copperAtomic: '4000' },
    ], checkpointSequences: [45, 80] };
    const prepared = rewards.prepare('alice', evidence, 2);
    assert.equal(prepared.receipt.amount, '4000');
    assert.equal(prepared.receipt.sequence, '80');
    assert.equal(verify(null, rewardMessage(prepared.receipt), publicKey, Buffer.from(prepared.signature, 'base64')), true);
    assert.equal(prepared.transaction.actions[0].params.methodName, 'claim_reward');
    assert.equal(prepared.transaction.actions[0].params.deposit, '0');
    assert.equal(prepared.status, 'prepared');
    assert.throws(() => rewards.prepare('alice', { ...evidence, mode: 'practice' }, 1), { code: 'INVALID_REWARD_EVIDENCE' });
    rewards.close();
    rewards = openRunRewards(join(directory, 'rewards.sqlite'), options);
    assert.deepEqual(rewards.prepare('alice', evidence, 2), prepared);
    assert.throws(() => rewards.reserve('alice', 'another'), { code: 'REWARD_BUDGET_EXHAUSTED' });
  } finally {
    runs.close();
    rewards.close();
    rmSync(directory, { recursive: true, force: true });
  }
});


test('quota survives new epochs and out-of-order claims cannot exceed a run cap', () => {
  const directory = mkdtempSync(join(tmpdir(), 'veilbound-epochs-'));
  const { privateKey } = generateKeyPairSync('ed25519');
  const file = join(directory, 'rewards.sqlite');
  const options = {
    privateKey, contractId: 'core.vibebound.testnet', ruleset: 'veilbound-v1', epoch: '1',
    epochEndsAtMs: 2000, runBudgetAtomic: '10000', totalBudgetAtomic: '10000',
    now: () => 1000, beneficiaryForPlayer: () => 'alice.testnet',
  };
  let rewards = openRunRewards(file, options);
  try {
    rewards.reserve('alice', 'run-1');
    const evidence = { mode: 'expedition', runId: 'run-1', checkpoints: [
      { region: 1, node: 'sanctum', copperAtomic: '7500' },
      { region: 2, node: 'drowned-belfry', copperAtomic: '7500' },
      { region: 3, node: 'hunger-kiln', copperAtomic: '7500' },
    ], checkpointSequences: [1, 2, 3] };
    assert.equal(rewards.prepare('alice', evidence, 2).receipt.amount, '2500');
    assert.equal(rewards.prepare('alice', evidence, 1).receipt.amount, '7500');
    assert.throws(() => rewards.prepare('alice', evidence, 3), { code: 'REWARD_CAP_REACHED' });
    assert.throws(() => rewards.prepare('bob', evidence, 1), { code: 'REWARD_RESERVATION_MISSING' });
    rewards.close();
    rewards = openRunRewards(file, { ...options, epoch: '2', epochEndsAtMs: 3000 });
    assert.throws(() => rewards.reserve('alice', 'run-2'), { code: 'REWARD_BUDGET_EXHAUSTED' });
  } finally {
    rewards.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('claim preparation rejects a modified persisted run after replay validation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'veilbound-replay-reward-'));
  const { privateKey } = generateKeyPairSync('ed25519');
  const rewards = openRunRewards(join(directory, 'reward.sqlite'), {
    privateKey, contractId: 'core.vibebound.testnet', ruleset: 'veilbound-v1', epoch: '1',
    epochEndsAtMs: 2000, runBudgetAtomic: '10000', totalBudgetAtomic: '10000',
    now: () => 1000, beneficiaryForPlayer: () => 'alice.testnet',
  });
  const path = join(directory, 'runs.sqlite');
  let runs = openRuns(path, { rewards });
  try {
    const entry = runs.start('alice', { mode: 'expedition', operationId: 'start' });
    runs.act('alice', entry.runId, { operationId: 'event', expectedVersion: 0, intent: { type: 'event', choice: 'enter' } });
    runs.close();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path);
    try {
      const row = JSON.parse(db.prepare('SELECT document FROM game_run_accounts WHERE account_id = ?').get('alice').document);
      row.runs[entry.runId].state.copper = 1000000;
      db.prepare('UPDATE game_run_accounts SET document = ? WHERE account_id = ?').run(JSON.stringify(row), 'alice');
    } finally { db.close(); }
    runs = openRuns(path, { rewards });
    await assert.rejects(runs.prepareBank('alice', entry.runId, 1), { code: 'RUN_REPLAY_MISMATCH' });
  } finally {
    runs.close();
    rewards.close();
    rmSync(directory, { recursive: true, force: true });
  }
});


test('reward bootstrap defaults disabled and checks final signer, epoch and capacity before enabling', async () => {
  const { bootstrapRunRewards } = await import('../../server/src/economy/reward-bootstrap.mjs');
  const { writeFileSync } = await import('node:fs');
  assert.equal(await bootstrapRunRewards({ env: {} }), undefined);
  const directory = mkdtempSync(join(tmpdir(), 'veilbound-bootstrap-'));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const receiptSigner = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
  const config = {
    network: 'testnet', rootAccountId: 'vibebound.testnet', receiptSigner, ruleset: 'veilbound-v1',
    globalRewardCap: '1000000', epochRewardCap: '200000', epochLengthNs: '1000000000',
  };
  const keyPath = join(directory, 'key.pem');
  const configPath = join(directory, 'config.json');
  writeFileSync(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }));
  writeFileSync(configPath, JSON.stringify(config));
  const env = {
    VEILBOUND_REWARDS_ENABLED: 'true', VEILBOUND_REWARD_KEY_PATH: keyPath, VEILBOUND_REWARD_CONFIG_PATH: configPath,
    VEILBOUND_CORE_ID: 'core.vibebound.testnet', VEILBOUND_COPPER_ID: 'copper.vibebound.testnet',
  };
  let failBudget = false;
  let time = 1000;
  const transport = async (_url, request) => {
    const { params } = JSON.parse(request.body);
    assert.equal(params.finality, 'final');
    const value = params.method_name === 'get_reward_config' ? {
      receipt_signer: receiptSigner, ruleset: config.ruleset, copper_id: env.VEILBOUND_COPPER_ID,
    } : {
      epoch: String(Math.floor(time / 1000)), epoch_length_ns: config.epochLengthNs, global_reward_cap: config.globalRewardCap,
      rewards_minted: '0', epoch_reward_cap: config.epochRewardCap, epoch_minted: failBudget ? '199999' : '0',
    };
    return { ok: true, json: async () => ({ result: { result: [...Buffer.from(JSON.stringify(value))], block_hash: 'final-block' } }) };
  };
  try {
    const rewards = await bootstrapRunRewards({
      env, file: join(directory, 'rewards.sqlite'), transport, now: () => time, beneficiaryForPlayer: () => 'alice.testnet',
    });
    assert.equal(rewards.reserve('alice', 'run-bootstrap').maximumAtomic, '10000');
    const evidence = { mode: 'expedition', runId: 'run-bootstrap', checkpoints: [1500, 2900, 4000, 3800, 10300].map(
      (copper, index) => ({ region: index + 1, node: `boss-${index + 1}`, copperAtomic: String(copper) })),
      checkpointSequences: [10, 20, 30, 40, 50] };
    assert.equal(rewards.prepare('alice', evidence, 5).receipt.amount, '3000');
    assert.equal(rewards.prepare('alice', evidence, 4).receipt.amount, '2000');
    time = 2000;
    assert.equal(rewards.needsRefresh(), true);
    await Promise.all([rewards.refresh(), rewards.refresh()]);
    assert.equal(rewards.reserve('alice', 'run-new-epoch').epoch, '2');
    assert.equal(rewards.prepare('alice', evidence, 5).receipt.epoch, '1');
    rewards.close();
    failBudget = true;
    await assert.rejects(bootstrapRunRewards({
      env, file: ':memory:', transport, now: () => time, beneficiaryForPlayer: () => 'alice.testnet',
    }), /capacity/);
    await assert.rejects(bootstrapRunRewards({
      env: { ...env, VEILBOUND_CORE_ID: 'core.other.testnet' }, file: ':memory:', transport,
      now: () => 1000, beneficiaryForPlayer: () => 'alice.testnet',
    }), /mismatch/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('HTTP bank preparation only accepts the session player and server-owned checkpoint selector', async () => {
  const { createGameServer } = await import('../../server/src/http.mjs');
  const { openGuestSessions } = await import('../../server/src/auth/guest.mjs');
  const { once } = await import('node:events');
  const sessions = openGuestSessions(':memory:');
  const guest = sessions.create();
  const origin = 'http://reward.test';
  const calls = [];
  const runs = {
    async prepareBank(...args) { calls.push(args); return { status: 'prepared' }; },
    async start(...args) { calls.push(args); return { mode: args[1].mode }; },
  };
  const server = createGameServer({ sessions, runs, origin });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { origin, cookie: 'veilbound_guest=' + guest.token };
  try {
    const request = (path, body) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal((await request('/api/runs/test-run/prepare-bank', { region: 1, accountId: 'attacker.testnet' })).status, 400);
    assert.equal((await request('/api/runs/test-run/prepare-bank', { region: 1 })).status, 200);
    assert.deepEqual(calls[0], [guest.playerId, 'test-run', 1]);
    assert.equal((await request('/api/runs', { mode: 'expedition', operationId: 'start' })).status, 200);
    assert.equal(calls[1][1].mode, 'expedition');
  } finally {
    await new Promise(resolve => server.close(resolve));
    sessions.close();
  }
});


test('retry recovers the same reservation after a crash before run persistence', async () => {
  const { createRunService } = await import('../../server/src/runs/service.mjs');
  const { openSqliteRunRepository } = await import('../../server/src/runs/repository.mjs');
  const { privateKey } = generateKeyPairSync('ed25519');
  const rewards = openRunRewards(':memory:', {
    privateKey, contractId: 'core.vibebound.testnet', ruleset: 'veilbound-v1', epoch: '1',
    epochEndsAtMs: 2000, runBudgetAtomic: '10000', totalBudgetAtomic: '10000',
    now: () => 1000, beneficiaryForPlayer: () => 'alice.testnet',
  });
  const repository = openSqliteRunRepository(':memory:');
  try {
    const broken = createRunService({ rewards, repository: {
      update(player, work) { return repository.update(player, account => { work(account); throw new Error('crash'); }); },
    } });
    assert.throws(() => broken.start('alice', { mode: 'expedition', operationId: 'durable-start' }), /crash/);
    const restored = createRunService({ rewards, repository });
    assert.equal(restored.active('alice'), null);
    const resumed = restored.start('alice', { mode: 'expedition', operationId: 'durable-start' });
    assert.equal(resumed.rewardReservation.maximumAtomic, '10000');
    assert.throws(() => rewards.reserve('alice', 'other-run'), { code: 'REWARD_BUDGET_EXHAUSTED' });
  } finally { repository.close(); rewards.close(); }
});

