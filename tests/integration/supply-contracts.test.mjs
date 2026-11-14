import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMap } from '../../shared/map-generator.mjs';
import { openFieldContracts } from '../../server/src/orders/field.mjs';
import { prepareCraft, recipeFor, selectSpecialty } from '../../shared/crafting.mjs';
import { prepareProcurementDelivery } from '../../server/src/orders/procurement.mjs';

function fixture() {
  const graph = generateMap(1);
  let now = 100;
  let evidence = { mode: 'expedition', runId: 'run-1', version: 1, graph, state: { phase: 'map', node: 'cache' }, observations: [] };
  const runs = { verifyProgress(account, id) {
    if (account !== 'alice' || id !== evidence.runId) throw new Error('unknown_run');
    return evidence;
  } };
  const calls = [];
  const funder = Object.fromEntries(['reserve', 'pay', 'release'].map(action => [action, async intent => {
    if (!calls.some(entry => entry.id === intent.operationId)) calls.push({ action, id: intent.operationId });
    return { status: 'final', operationId: intent.operationId, receiptId: action + '-receipt' };
  }]));
  const offer = { id: 'graft-watch', objective: 'graft', delivery: 'sanctum', rewardAtomic: '250', endsAt: 200 };
  const service = openFieldContracts(':memory:', { runs, funder, now: () => now, offers: [offer] });
  return { service, offer, calls, setTime: value => { now = value; }, setProof: (version, observations) => { evidence = { ...evidence, version, observations }; } };
}

test('field contracts settle only a fresh server-verified elite clear followed by its boss checkpoint', async () => {
  const { service, calls, setProof } = fixture();
  try {
    const accepted = await service.accept('alice', { runId: 'run-1', offerId: 'graft-watch' });
    assert.equal(accepted.status, 'accepted');
    await assert.rejects(service.deliver('alice', accepted.id), /objective_incomplete/);
    setProof(4, [{ sequence: 1, kind: 'encounter-clear', node: 'graft' }, { sequence: 4, kind: 'checkpoint', node: 'sanctum' }]);
    await assert.rejects(service.deliver('alice', accepted.id), /objective_incomplete/);
    setProof(5, [{ sequence: 2, kind: 'encounter-clear', node: 'graft' }, { sequence: 5, kind: 'checkpoint', node: 'sanctum' }]);
    await assert.rejects(service.deliver('bob', accepted.id), /contract_missing/);
    const paid = await Promise.all([service.deliver('alice', accepted.id), service.deliver('alice', accepted.id)]);
    assert.equal(paid[0].status, 'paid');
    assert.deepEqual(paid[0], paid[1]);
    assert.deepEqual(calls.map(call => call.action), ['reserve', 'pay']);
    assert.equal(paid[0].evidence.tradable, false);
  } finally { service.close(); }
});

test('expired field contracts release the reservation once', async () => {
  const { service, calls, setTime } = fixture();
  try {
    const accepted = await service.accept('alice', { runId: 'run-1', offerId: 'graft-watch' });
    setTime(200);
    await assert.rejects(service.deliver('alice', accepted.id), /contract_expired/);
    assert.equal((await service.recover('alice', accepted.id)).status, 'expired');
    assert.deepEqual(calls.map(call => call.action), ['reserve', 'release']);
  } finally { service.close(); }
});

test('crafting requires a pinned recipe, eligible specialty and settled materials', () => {
  const recipe = recipeFor('apothecary-ward-v1', 1);
  const lots = [{ id: 'a', itemId: 'salt', quantity: 2, provenance: 'settled' }, { id: 'b', itemId: 'resin', quantity: 1, provenance: 'practice' }];
  assert.throws(() => prepareCraft({ recipeId: recipe.id, version: 1, lots, workshop: 'public' }), /unsettled/);
  lots[1].provenance = 'settled';
  const profession = selectSpecialty({ unlocked: ['apothecary'] }, 'apothecary');
  assert.equal(prepareCraft({ recipeId: recipe.id, version: 1, lots, profession }).output.itemId, 'ward');
  assert.throws(() => prepareCraft({ recipeId: recipe.id, version: 2, lots, workshop: 'public' }), /unknown_recipe/);
});

test('procurement accepts settled P2P stock and retains the funded order version', async () => {
  const chain = { async getFinalizedBuyOrder() {
    return { id: 'order', buyer: 'workshop', itemId: 'salt', remaining: 3, reservedCopperAtomic: '60', unitPriceAtomic: '20', version: 5, endsAt: 1000, status: 'open' };
  } };
  const input = { orderId: 'order', accountId: 'alice', quantity: 2, lots: [{ id: 'a', itemId: 'salt', quantity: 2, provenance: 'settled', accountId: 'alice' }] };
  const prepared = await prepareProcurementDelivery(chain, input, 100);
  assert.equal(prepared.expectedVersion, 5);
  assert.equal(prepared.payoutAtomic, '40');
  await assert.rejects(prepareProcurementDelivery(chain, { ...input, accountId: 'workshop' }, 100), /self_fill/);
});
