import test from 'node:test';
import assert from 'node:assert/strict';
import { makeUpgradePlans, planDigest, receiptMatchesBatch } from '../../scripts/lib/upgrade.mjs';

const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
test('upgrade plan pauses Core before Copper and Core upgrade and emits unpause separately', () => {
  const result = makeUpgradePlans({ rootAccountId: 'vibebound.testnet', binaries: { copper: wasm, core: wasm },
    previousArtifacts: { copper: { sha256: 'a'.repeat(64) }, core: { sha256: 'b'.repeat(64) } } });
  assert.equal(result.upgrade.phase, 'upgrade');
  assert.deepEqual(result.upgrade.batches.map(batch => batch.actions[0].params.methodName), ['set_paused', 'upgrade', 'upgrade']);
  assert.equal(result.upgrade.batches[0].actions[0].params.args.paused, true);
  assert.equal(result.upgrade.batches[1].actions[0].params.args.wasm, wasm.toString('base64'));
  assert.equal(result.unpause.batches.length, 1);
  assert.equal(result.unpause.batches[0].actions[0].params.args.paused, false);
  assert.equal(result.unpause.requiresUpgradeDigest, planDigest(result.upgrade));
});

test('phase receipts compare signed action contents and reject a valid receipt for different arguments', () => {
  const batch = { receiverId: 'core.vibebound.testnet', actions: [{ type: 'FunctionCall',
    params: { methodName: 'set_paused', args: { paused: true }, deposit: '0', gas: '50000000000000' } }] };
  const plan = { rootAccountId: 'vibebound.testnet', batches: [batch] };
  const receipt = { result: {
    final_execution_status: 'FINAL', status: { SuccessValue: '' }, receipts_outcome: [],
    transaction: { signer_id: plan.rootAccountId, receiver_id: batch.receiverId, actions: [{
      FunctionCall: { method_name: 'set_paused', args: Buffer.from(JSON.stringify({ paused: true })).toString('base64'),
        deposit: '0', gas: 50000000000000 },
    }] },
  } };
  assert.equal(receiptMatchesBatch(plan, 0, receipt), true);
  receipt.result.transaction.actions[0].FunctionCall.args = Buffer.from(JSON.stringify({ paused: false })).toString('base64');
  assert.equal(receiptMatchesBatch(plan, 0, receipt), false);
});
