import { createHash } from 'node:crypto';

const materialByRegion = Object.freeze({
  wood: ['resin', 'heartwood-knot'],
  water: ['salt', 'tideglass-core'],
  fire: ['ash', 'cinder-heart'],
  metal: ['iron', 'warden-rivet'],
  earth: ['thread', 'veil-lens'],
});

export const MATERIAL_REWARD_VERSION = 'region-materials-v1';

export function trackMaterials({ before, after, node, runId, sequence, checkpoint }) {
  const pending = { ...before.materialRewards?.pending };
  const policy = materialByRegion[node?.region];
  if (policy && before.phase === 'battle' && after.phase === 'reward') {
    const [material, trophy] = policy;
    pending[material] = (pending[material] ?? 0) + (node.type === 'elite' ? 2 : 1);
    if (node.type === 'boss') pending[trophy] = (pending[trophy] ?? 0) + 1;
  }
  if (checkpoint) {
    checkpoint.materials = Object.entries(pending).sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([itemId, quantity]) => ({
        entitlementId: createHash('sha256').update(JSON.stringify([MATERIAL_REWARD_VERSION, runId, sequence, itemId])).digest('hex'),
        itemId, quantity: String(quantity), status: 'pending', provenance: 'expedition-run',
      }));
  }
  after.materialRewards = {
    pending: checkpoint || after.phase === 'defeat' ? {} : pending,
  };
}

