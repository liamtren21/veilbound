import { readFileSync } from 'node:fs';

const trials = JSON.parse(readFileSync(new URL('../../../config/accord-trials.json', import.meta.url), 'utf8'));
const talismans = ['gate', 'river', 'lantern'];

export function migrateTrialProgress(progress = {}) {
  if (progress.version === 1) return structuredClone(progress);
  const clears = talismans.filter(id => progress.talismans?.[id]?.wins > 0);
  return { version: 1, legacy: structuredClone(progress), clears, completed: [], lore: [], receipts: [], rewards: [] };
}

export function availableTrials(progress) {
  return progress.clears.length ? structuredClone(trials.slice(0, progress.completed.length + 1)) : [];
}

export function recordTalismanClear(progress, { talisman, outcome }) {
  if (outcome !== 'won' || !talismans.includes(talisman) || progress.clears.includes(talisman)) return progress;
  return { ...progress, clears: [...progress.clears, talisman] };
}

export function settleTrial(progress, { trialId, outcome, talisman, replayId }) {
  if (!talismans.includes(talisman) || !['won', 'lost'].includes(outcome) ||
      typeof replayId !== 'string' || !replayId) throw new Error('invalid_trial_evidence');
  const trial = availableTrials(progress).find(item => item.id === trialId);
  if (!trial) throw new Error('trial_locked');
  if (progress.receipts.some(item => item.replayId === replayId)) return progress;
  const firstClear = outcome === 'won' && !progress.completed.includes(trialId);
  const loreId = JSON.stringify([trialId, talisman]);
  return {
    ...progress,
    completed: firstClear ? [...progress.completed, trialId] : progress.completed,
    lore: outcome === 'won' && !progress.lore.some(item => item.id === loreId)
      ? [...progress.lore, { id: loreId, talisman, trialId, replayId }]
      : progress.lore,
    receipts: [...progress.receipts, { replayId, trialId, talisman, outcome }],
    rewards: firstClear ? [...progress.rewards, { trialId, replayId, ...trial.reward }] : progress.rewards,
  };
}
