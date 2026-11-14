import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { openRuns } from '../../server/src/runs/service.mjs';
import { createVaultPurse } from '../../server/src/runs/vault-purse.mjs';
import { createOwnedItems } from '../../server/src/runs/owned-items.mjs';

test('owned items wait for finalized custody and cancellation releases the whole reservation', async () => {
  let record;
  const ownedItems = createOwnedItems({ coreId: 'core.demo.testnet', ruleset: 'test-rules',
    privateKey: generateKeyPairSync('ed25519').privateKey, readReservation: async () => record });
  const runs = openRuns(':memory:', { ownedItems, rewards: { reserve: () => ({ beneficiary: 'alice.testnet' }) } });
  try {
    const { runId } = runs.start('alice', { mode: 'expedition', operationId: 'initial' });
    const tx = runs.prepareOwnedItems('alice', runId, { salve: 2 });
    const reservation = tx.actions[0].params.args.receipt;
    assert.deepEqual(runs.get('alice', runId).loadoutPreparation, { purseAtomic: null, ownedItems: { salve: '2' }, chronicleToken: null });
    assert.deepEqual(await runs.supplyStatus('alice', runId), { purse: null, items: 'unreserved' });
    await assert.rejects(runs.confirmOwnedItems('alice', runId), /RESERVATION_PENDING/);
    record = { reservation, consumed: null };
    assert.equal((await runs.confirmOwnedItems('alice', runId)).state.pack.salve, 2);
    assert.deepEqual(await runs.supplyStatus('alice', runId), { purse: null, items: 'reserved' });
    record = { reservation, consumed: ['1'] };
    assert.deepEqual(await runs.supplyStatus('alice', runId), { purse: null, items: 'settled' });
    record = { reservation, consumed: null };
    assert.equal((await runs.confirmOwnedItems('alice', runId)).state.pack.salve, 2);
    assert.equal(runs.replay('alice', runId).verified, true);
    assert.throws(() => runs.prepareOwnedItemsClose('alice', runId), /CLOSE_UNAVAILABLE/);
    const cancelled = runs.start('bob', { mode: 'expedition', operationId: 'other' });
    runs.prepareOwnedItems('bob', cancelled.runId, { ward: 1 });
    runs.cancelOwnedItems('bob', cancelled.runId);
    const close = runs.prepareOwnedItemsClose('bob', cancelled.runId);
    assert.deepEqual(close.actions[0].params.args.receipt.consumed, ['0']);
    assert.equal(runs.replay('bob', cancelled.runId).verified, true);
  } finally { runs.close(); }
});

test('cancelled Copper reservation remains accessible through history after starting another run', async () => {
  let record = null;
  const vaultPurse = createVaultPurse({ contractId: 'core.demo.testnet', ruleset: 'test-rules',
    privateKey: generateKeyPairSync('ed25519').privateKey, readPurse: async () => record });
  const runs = openRuns(':memory:', { vaultPurse, rewards: { reserve: () => ({ beneficiary: 'alice.testnet' }) } });
  try {
    const { runId } = runs.start('alice', { mode: 'expedition', operationId: 'initial' });
    assert.deepEqual(runs.loadoutCapabilities(), { purse: true, items: false });
    const { receipt } = runs.prepareVaultPurse('alice', runId, '300').actions[0].params.args;
    assert.equal(runs.get('alice', runId).loadoutPreparation.purseAtomic, '300');
    await assert.rejects(runs.confirmVaultPurse('alice', runId), /VAULT_PURSE_PENDING/);
    assert.deepEqual(await runs.supplyStatus('alice', runId), { purse: 'unreserved', items: null });
    record = { reservation: receipt, close: null, settled: false };
    await runs.confirmVaultPurse('alice', runId, { cancel: true });
    const replacement = runs.start('alice', { mode: 'expedition', operationId: 'replacement' });
    assert.equal(runs.active('alice').runId, replacement.runId);
    assert.equal(runs.expeditionHistory('alice')[0].runId, runId);
    assert.deepEqual(runs.expeditionHistory('bob'), []);
    await assert.rejects(runs.supplyStatus('bob', runId), /RUN_NOT_FOUND/);
    assert.deepEqual(await runs.supplyStatus('alice', runId), { purse: 'reserved', items: null });
    const close = runs.prepareVaultPurseClose('alice', runId).actions[0].params.args.receipt;
    assert.equal(close.returned, '300');
    record = { ...record, close };
    assert.equal((await runs.supplyStatus('alice', runId)).purse, 'pending');
    record.settled = true;
    assert.equal((await runs.supplyStatus('alice', runId)).purse, 'settled');
    assert.equal(runs.replay('alice', runId).verified, true);
  } finally { runs.close(); }
});
