import { isCount } from '../../../shared/scoring.mjs';

const objectiveValues = new Map([['ward', 2], ['mark', 1], ['counter', 2], ['protect', 2], ['core', 2]]);

export function raidPhase(round) {
  if (!Number.isInteger(round) || round < 1 || round > 8) throw new Error('invalid_raid_round');
  return round <= 2 ? 'ward' : round <= 5 ? 'counter' : 'core';
}

export function raidContribution(result, contributionCap, remainingHp) {
  if (!isCount(result.damage) || !isCount(result.rounds) || result.rounds < 1 || result.rounds > 8 ||
      !Array.isArray(result.objectives) || result.objectives.some(id => !objectiveValues.has(id)) ||
      typeof result.clear !== 'boolean' || typeof result.replayId !== 'string' || !result.replayId) {
    throw new Error('invalid_raid_evidence');
  }
  const objectivePoints = [...new Set(result.objectives)].reduce((total, id) => total + objectiveValues.get(id), 0);
  const damage = Math.min(result.damage, contributionCap);
  const personalScore = objectivePoints + Math.floor(5 * (damage / contributionCap)) + (result.clear ? 2 : 0);
  return { contribution: Math.min(damage, remainingHp), personalScore, replayId: result.replayId };
}
