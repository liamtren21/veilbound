import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { createChronicle } from '../../server/src/progression/chronicle.mjs';

test('Relic evolution uses a finalized Chronicle and quotes the registered stage cost before signing', async () => {
  let blockHash = 'final-block';
  let stage = 0;
  let entry = null;
  const resources = { locked: false, copperAtomic: '400', storageYocto: '10000000000000000000000', items: ['2', '1'] };
  const view = value => ({ blockHash, value });
  const binding = { tokenId: 'rook-relic', accountId: 'alice.testnet', epoch: '2' };
  const recipe = { item_ids: ['salt', 'wood-trophy'], amounts: ['2', '1'], copper_cost: '400' };
  const chronicle = createChronicle({
    coreId: 'core.demo.testnet', ruleset: 'test-rules', accountForPlayer: player => player + '.testnet',
    privateKey: generateKeyPairSync('ed25519').privateKey,
    runs: { verifyProgress: () => ({ mode: 'expedition', chronicleBinding: binding, checkpoints: [{ region: 3 }, { region: 5 }] }) },
    economy: {
      artifact: async () => ({
        token: { blockHash: 'final-block', value: { owner_id: 'alice.testnet' } },
        artifact: view({ kind: 'RELIC', status: 'ready', epoch: '2' }), stage: view(stage), sale: view(null),
      }),
      chronicleEntry: async (tokenId, entryId, block) => {
        assert.equal(tokenId, binding.tokenId);
        assert.match(entryId, /^[0-9a-f]{64}$/);
        assert.equal(block, 'final-block');
        return view(entry);
      },
      evolutionRecipe: async (requested, block) => {
        assert.equal(block, 'final-block');
        assert.equal(requested, 1);
        return view(recipe);
      },
      evolutionResources: async () => resources,
      prepareEvolution: input => input,
    },
  });
  const quote = achievement => chronicle.evolution('alice', 'run-1', achievement);
  const prepared = await chronicle.prepare('alice', 'run-1', 'region-3-clear');
  const { receipt } = prepared.actions[0].params.args;
  assert.equal((await quote('region-3-clear')).status, 'milestone_pending');
  entry = { achievement: 'five-region-clear', ruleset: 'test-rules', run_id: 'run-1' };
  assert.equal((await quote('five-region-clear')).status, 'previous_stage_required');
  entry.achievement = 'region-3-clear';
  resources.locked = true;
  assert.equal((await quote('region-3-clear')).status, 'relic_locked');
  resources.locked = false;
  resources.items[0] = '1';
  assert.deepEqual((await quote('region-3-clear')).missing.items, ['salt']);
  resources.items[0] = '2';
  const ready = await quote('region-3-clear');
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.cost, { copperAtomic: '400', items: [{ id: 'salt', quantity: '2' }, { id: 'wood-trophy', quantity: '1' }] });
  assert.equal(ready.transaction.entryId, receipt.entry_id);
  stage = 1;
  assert.equal((await quote('region-3-clear')).status, 'evolved');
  blockHash = 'different';
  await assert.rejects(quote('region-3-clear'), /RELIC_UNAVAILABLE/);
  await assert.rejects(chronicle.evolution('bob', 'run-1', 'region-3-clear'), /CHRONICLE_MILESTONE_UNAVAILABLE/);
});
