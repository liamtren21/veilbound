import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyRunCopperCheckpoint } from '../../shared/run-copper.mjs';
import { canExportItem, runItemProvenance } from '../../shared/inventory-provenance.mjs';

test('boss checkpoints bank run-only Copper and defeat removes only the unbanked amount', () => {
  const bank = applyRunCopperCheckpoint({ copper: 43, phase: 'event' }, { region: 1, node: 'sanctum' });
  assert.deepEqual(bank, {
    remaining: 22, checkpoint: { region: 1, node: 'sanctum', copperAtomic: '2100', settlement: 'run-only' },
    lostCopperAtomic: '0',
  });
  const defeat = applyRunCopperCheckpoint({ copper: bank.remaining + 10, phase: 'defeat' });
  assert.equal(defeat.lostCopperAtomic, '3200');
  assert.equal(defeat.remaining, 0);
  assert.equal(defeat.checkpoint, null);
  assert.equal(bank.checkpoint.copperAtomic, '2100');
});

test('ending banks the rest and only settled item provenance permits export', () => {
  const ending = applyRunCopperCheckpoint({ copper: 37, phase: 'complete' }, { region: 5, node: 'sunken-tribunal' });
  assert.equal(ending.remaining, 0);
  assert.equal(ending.checkpoint.copperAtomic, '3700');
  for (const mode of ['practice', 'weekly', 'expedition']) {
    assert.equal(canExportItem(runItemProvenance(mode)), false);
  }
  assert.equal(canExportItem(runItemProvenance('practice', { tutorial: true })), false);
  assert.equal(canExportItem('settled'), true);
});
