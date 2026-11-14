import assert from 'node:assert/strict';
import { test } from 'node:test';
import { regions } from '../../expedition-data.mjs';
import { canDeliverContract, generateMap } from '../../shared/map-generator.mjs';

test('10,000 Expedition maps have reachable safe and elite routes, shops, and no dead ends', () => {
  const variants = new Set();
  for (let seed = 0; seed < 10_000; seed++) {
    const graph = generateMap(seed);
    variants.add(graph.nodes.cache.next.slice().sort().join(','));
    for (const region of regions) {
      const regionNodes = Object.entries(graph.nodes).filter(([, node]) => node.region === region.id);
      const quota = new Set();
      for (const [id, node] of regionNodes) {
        if (id === region.boss) continue;
        assert.ok(canDeliverContract(graph, region.entry, id, region.boss));
        quota.add(node.type);
      }
      for (const type of ['merchant', 'camp', 'elite', 'story']) assert.ok(quota.has(type));
    }
  }
  assert.ok(variants.size > 1, 'seed must vary topology, beyond reordering choices');
});

test('tutorial first region is stable, replay is deterministic, and unreachable contracts are rejected', () => {
  const first = generateMap(1, { tutorial: true });
  assert.deepEqual(first, generateMap(1, { tutorial: true }));
  const wood = graph => Object.entries(graph.nodes).filter(([, node]) => node.region === 'wood');
  assert.deepEqual(wood(first), wood(generateMap(2, { tutorial: true })));
  assert.equal(canDeliverContract(first, 'threshold', 'camp', 'graft'), false);
  assert.equal(canDeliverContract(first, 'threshold', 'graft', 'market'), false);
  assert.equal(canDeliverContract(first, 'threshold', 'graft', 'drowned-belfry'), true);
});
