import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { canExportItem } from '../../shared/inventory-provenance.mjs';
import { openJourneyShares } from '../../server/src/runs/journey-shares.mjs';
import { openRuns } from '../../server/src/runs/service.mjs';
import { createMaterialClaims, materialRewardMessage } from '../../server/src/runs/material-claims.mjs';
import { validateVaultPurseCarry } from '../../server/src/runs/vault-purse.mjs';

test('accepted expedition actions bank materials once and sign only a replay-derived entitlement', async () => {
  const fixture = JSON.parse(readFileSync(new URL('../../evidence/gameplay-loss.json', import.meta.url)));
  const secret = createHash('sha256').update(fixture.seed).digest();
  const rewards = { reserve: () => ({ maximumAtomic: '10000', beneficiary: 'alice.testnet' }) };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  let finalClaim;
  let remaining = '0';
  const materialClaims = createMaterialClaims({
    contractId: 'core.vibebound.testnet', ruleset: 'rules-v1', privateKey,
    readBudget: async () => [remaining, '0'], readClaim: async () => finalClaim,
  });
  const runs = openRuns(':memory:', { rewards, materialClaims, storyVersion: 0, entropy: () => secret });
  try {
    let snapshot = runs.start('alice', { mode: 'expedition', operationId: 'start' });
    for (const { intent, sequence } of fixture.events) {
      snapshot = runs.act('alice', snapshot.runId, {
        operationId: 'action-' + sequence, expectedVersion: sequence - 1, intent,
      });
    }
    assert.equal(snapshot.lifecycle, 'LOST');
    const shares = openJourneyShares(':memory:', runs);
    try {
      await assert.rejects(shares.publish('bob', snapshot.runId), { code: 'RUN_NOT_FOUND' });
      const published = await shares.publish('alice', snapshot.runId);
      assert.deepEqual(await shares.publish('alice', snapshot.runId), published);
      const view = shares.read(new URL(published.path, 'http://localhost').searchParams.get('id'));
      assert.equal(view.outcome, 'lost');
      assert.equal(view.digest, snapshot.stateHash);
      assert.ok(view.highlights.length >= 1);
      assert.equal(view.frames.length, fixture.events.length);
      assert.equal(view.frames.at(-1).phase, 'defeat');
      const id = new URL(published.path, 'http://localhost').searchParams.get('id');
      const challenge = await shares.challenge('bob', id);
      assert.equal(challenge.mode, 'journey');
      assert.equal(challenge.rewardReservation, null);
      assert.equal(challenge.state.talisman, snapshot.state.talisman);
      assert.equal((await shares.challenge('bob', id)).runId, challenge.runId);
      assert.deepEqual(runs.verifyProgress('bob', challenge.runId).graph, runs.verifyProgress('alice', snapshot.runId).graph);
      assert.deepEqual(Object.keys(view).sort(), ['decisions', 'digest', 'frames', 'highlights', 'outcome', 'talisman', 'version']);
    } finally {
      shares.close();
    }
    assert.deepEqual(snapshot.state.materialRewards.pending, {});
    const bank = runs.materialBank('alice', snapshot.runId);
    assert.deepEqual(bank, runs.materialBank('alice', snapshot.runId));
    const last = fixture.events.at(-1);
    assert.deepEqual(snapshot, runs.act('alice', snapshot.runId, {
      operationId: 'action-' + last.sequence, expectedVersion: last.sequence - 1, intent: last.intent,
    }));
    assert.deepEqual(bank, runs.materialBank('alice', snapshot.runId));
    assert.deepEqual(bank.entitlements.map(({ itemId, quantity, region }) => [itemId, quantity, region]),
      [['heartwood-knot', '1', 1], ['resin', '2', 1]]);
    assert.equal(new Set(bank.entitlements.map(row => row.entitlementId)).size, 2);
    assert.ok(bank.entitlements.every(row => row.status === 'pending' && !canExportItem(row.provenance)));
    assert.throws(() => runs.materialBank('bob', snapshot.runId), { code: 'RUN_NOT_FOUND' });
    const resin = bank.entitlements.find(item => item.itemId === 'resin');
    await assert.rejects(runs.prepareMaterialClaim('alice', snapshot.runId, resin.entitlementId),
      { code: 'MATERIAL_BUDGET_UNAVAILABLE' });
    remaining = '2';
    const prepared = await runs.prepareMaterialClaim('alice', snapshot.runId, resin.entitlementId);
    assert.equal(prepared.status, 'prepared');
    const { receipt, signature } = prepared.transaction.actions[0].params.args;
    assert.equal(receipt.account_id, 'alice.testnet');
    assert.equal(receipt.token_id, 'resin');
    assert.equal(receipt.amount, '2');
    assert.equal(receipt.sequence, '111');
    assert.ok(verify(null, materialRewardMessage(receipt), publicKey, Buffer.from(signature, 'base64')));
    assert.deepEqual(await runs.prepareMaterialClaim('alice', snapshot.runId, resin.entitlementId), prepared);
    await assert.rejects(runs.prepareMaterialClaim('bob', snapshot.runId, resin.entitlementId), { code: 'RUN_NOT_FOUND' });
    finalClaim = { ...receipt, amount: '1' };
    await assert.rejects(runs.prepareMaterialClaim('alice', snapshot.runId, resin.entitlementId), { code: 'MATERIAL_CHAIN_CONFLICT' });
    finalClaim = receipt;
    assert.deepEqual(await runs.prepareMaterialClaim('alice', snapshot.runId, resin.entitlementId),
      { status: 'settled', receipt, transaction: null });
  } finally { runs.close(); }
});

test('practice has no bank material entitlements', () => {
  const runs = openRuns(':memory:');
  try {
    const run = runs.start('alice');
    assert.deepEqual(runs.materialBank('alice', run.runId), { runId: run.runId, policy: null, entitlements: [] });
  } finally { runs.close(); }
});


test('positive purse carry requires finalized custody support', () => {
  assert.equal(validateVaultPurseCarry('0'), null);
  assert.equal(validateVaultPurseCarry('1'), 'INVALID_PURSE_CARRY');
  assert.equal(validateVaultPurseCarry('100'), 'VAULT_PURSE_UNAVAILABLE');
  assert.equal(validateVaultPurseCarry('4000'), 'VAULT_PURSE_UNAVAILABLE');
  for (const value of ['4001', '-1', '01', '1.5', 1, null]) {
    assert.equal(validateVaultPurseCarry(value), 'INVALID_PURSE_CARRY');
  }
});
