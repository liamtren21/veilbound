import { map, regions } from '../expedition-data.mjs';
import variants from '../config/encounter-variants.json' with { type: 'json' };

export const MAP_VERSION = 'orchard-five-v1';

export function generateMap(seed, { tutorial = false } = {}) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new TypeError('Expected a uint32 map seed');
  let random = seed;
  const pick = (count) => {
    random = (Math.imul(1664525, random) + 1013904223) >>> 0;
    return (random >>> 16) % count;
  };
  const graph = {};
  for (const region of regions) {
    for (const node of Object.values(map).filter(node => (node.region ?? 'wood') === region.id)) {
      const fixed = tutorial && region.number === 1;
      const next = [...node.next];
      if (!fixed) for (const candidate of variants.optionalEdges[node.id] ?? []) {
        if (pick(2)) next.push(candidate);
      }
      if (!fixed && next.length > 1 && pick(2)) next.reverse();
      const formations = !fixed ? variants.formations[node.id] : null;
      const enemies = formations ? [...formations[pick(formations.length)]] : node.enemies ? [...node.enemies] : null;
      if (!fixed && enemies?.length > 1 && pick(2)) enemies.reverse();
      graph[node.id] = {
        next, enemies, region: region.id, type: node.type,
        risk: node.type === 'elite' || node.type === 'boss' ? 'high' :
          enemies ? 'guarded' : 'safe',
      };
    }
  }
  return { version: MAP_VERSION, entry: regions[0].entry, nodes: graph };
}

export function canDeliverContract(graph, start, objective, delivery) {
  const reachable = (from, to, visited = new Set()) => {
    if (!Object.hasOwn(graph.nodes, from) || visited.has(from)) return false;
    if (from === to) return true;
    visited.add(from);
    const node = graph.nodes[from];
    const regionIndex = regions.findIndex(region => region.id === node.region);
    const nextEntry = from === regions[regionIndex]?.boss ? regions[regionIndex + 1]?.entry : null;
    const next = nextEntry ? [...node.next, nextEntry] : node.next;
    return next.some(id => reachable(id, to, visited));
  };
  return objective !== delivery && reachable(start, objective) && reachable(objective, delivery);
}

