export const isCount = value => Number.isSafeInteger(value) && value >= 0;

export function weeklyScore(result) {
  const { objective, rounds, faints, consumables, replayId } = result;
  if (typeof objective !== 'boolean' || ![rounds, faints, consumables].every(isCount) ||
      typeof replayId !== 'string' || !replayId) throw new Error('incomplete_run_evidence');
  return { objective, rounds, faints, consumables, replayId };
}

export function compareWeekly(left, right) {
  return Number(right.objective) - Number(left.objective) || left.rounds - right.rounds ||
    left.faints - right.faints || left.consumables - right.consumables;
}
