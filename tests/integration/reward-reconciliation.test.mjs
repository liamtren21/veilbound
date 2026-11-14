import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openRunRewards } from '../../server/src/economy/run-rewards.mjs';
import { openFinalRewardSnapshot, reconcileRewardReservation } from '../../server/src/economy/reward-reconciliation.mjs';

test('rollover reconciliation audits finalized releases once and preserves pending and settled quota', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'veilbound-reward-reconciliation-'));
  let active;
  t.after(() => {
    active?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const file = join(directory, 'rewards.sqlite');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const config = {
    network: 'testnet', rootAccountId: 'vibebound.testnet', ruleset: 'veilbound-v1', epochLengthNs: '1000000000',
    receiptSigner: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64'),
  };
  const contract = 'core.' + config.rootAccountId;
  const options = { privateKey, contractId: contract, ruleset: config.ruleset, epoch: '1', epochEndsAtMs: 2000,
    runBudgetAtomic: '10000', totalBudgetAtomic: '10000', now: () => 1000, beneficiaryForPlayer: () => 'alice.testnet' };
  const old = openRunRewards(file, options);
  const runId = 'test-run';
  old.reserve('alice', runId);
  const evidence = { mode: 'expedition', runId, checkpointSequences: [10, 20, 30, 40],
    checkpoints: [1, 2, 3, 4].map(region => ({ region, node: 'boss-' + region, copperAtomic: '2000' })) };
  const statuses = ['absent', 'expired', 'pending', 'settled'];
  const operations = new Map(statuses.map((status, index) => {
    const { receipt } = old.prepare('alice', evidence, index + 1);
    return [receipt.claim_id, status === 'absent' ? null : { status, amount: receipt.amount, receipt }];
  }));
  old.close();
  active = openRunRewards(file, { ...options, epoch: '2', finalizedEpoch: '2', epochEndsAtMs: 3000, now: () => 2000 });
  let blockTime = '2000000000';
  let wrongHash = false;
  const transport = async (_url, request) => {
    const { method, params } = JSON.parse(request.body);
    let result;
    if (method === 'block') {
      assert.deepEqual(params, { finality: 'final' });
      result = { header: { hash: 'final-block', timestamp_nanosec: blockTime } };
    } else {
      assert.equal(method, 'query');
      assert.equal(params.block_id, 'final-block');
      const args = JSON.parse(Buffer.from(params.args_base64, 'base64').toString());
      const values = {
        get_reward_config: { ruleset: config.ruleset, receipt_signer: config.receiptSigner, copper_id: 'copper.' + config.rootAccountId },
        get_reward_budget: { epoch: '2', epoch_length_ns: config.epochLengthNs },
        get_operation: operations.get(args.operation_id),
      };
      result = { block_hash: wrongHash ? 'different-block' : params.block_id,
        result: [...Buffer.from(JSON.stringify(values[params.method_name]))] };
    }
    return { ok: true, json: async () => ({ result }) };
  };
  const balance = () => {
    const db = new DatabaseSync(file, { readOnly: true });
    try { return db.prepare('SELECT reserved FROM run_reward_programs').get().reserved; }
    finally { db.close(); }
  };
  const reconcile = async apply => reconcileRewardReservation(file, {
    runId, snapshot: await openFinalRewardSnapshot(config, transport), apply,
  });
  assert.equal((await reconcile(false)).releasableAtomic, '2000', 'at the deadline absent receipts can still be accepted');
  blockTime = '2000000001';
  wrongHash = true;
  await assert.rejects(reconcile(true), /finalized snapshot/);
  wrongHash = false;
  assert.equal((await reconcile(false)).releasableAtomic, '4000');
  assert.equal(balance(), '8000');
  const releases = await Promise.all([reconcile(true), reconcile(true)]);
  assert.deepEqual(releases.map(result => result.releasedAtomic).sort(), ['0', '4000']);
  assert.equal(balance(), '4000');
  const audit = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = audit.prepare('SELECT status, released, finalized_block FROM run_reward_claim_releases ORDER BY status').all();
    assert.deepEqual(rows.map(row => Object.values(row)), [
      ['absent', '2000', 'final-block'], ['expired', '2000', 'final-block'],
    ]);
  } finally { audit.close(); }
  const prior = [...operations.values()].find(operation => operation?.status === 'pending');
  prior.receipt = { ...prior.receipt, account_id: 'other.testnet' };
  await assert.rejects(reconcile(true), /operation mismatch/);
  assert.equal(balance(), '4000');
});
