import { compareWeekly, isCount, weeklyScore } from '../../../shared/scoring.mjs';

export function createWeeklyOath({ week, combat, now = Date.now, snapshot }) {
  week = structuredClone(week);
  if (!week.id || !week.ruleset || !Array.isArray(week.roster) ||
      ![week.seed, week.startsAt, week.endsAt, week.graceMs, week.budget, week.rewardSlots, week.targetRounds].every(isCount) ||
      week.endsAt <= week.startsAt) throw new Error('invalid_week');
  const entries = new Map(snapshot?.entries);
  const best = new Map(snapshot?.best);
  const claims = new Map(snapshot?.claims);
  return {
    start(accountId, { practice = false } = {}) {
      const timestamp = now();
      if (timestamp < week.startsAt || timestamp >= week.endsAt) throw new Error('weekly_closed');
      const { runId } = combat.startRun(accountId, {
        mode: 'weekly', seed: week.seed, ruleset: week.ruleset, weeklyId: week.id,
        roster: [...week.roster], budget: week.budget, practice: Boolean(practice), exportLoot: false,
      });
      if (typeof runId !== 'string' || !runId || entries.has(runId)) throw new Error('invalid_run_start');
      const entry = { runId, accountId, practice: Boolean(practice) };
      entries.set(runId, entry);
      return structuredClone(entry);
    },
    settle(accountId, runId) {
      const entry = entries.get(runId);
      if (!entry || entry.accountId !== accountId) throw new Error('weekly_entry_missing');
      if (entry.result) return structuredClone(entry.result);
      if (now() >= week.endsAt + week.graceMs) throw new Error('weekly_grace_expired');
      const score = weeklyScore(combat.verifyRun(accountId, runId, { weeklyId: week.id, ruleset: week.ruleset, practice: entry.practice }));
      if (!entry.practice && (!best.has(accountId) || compareWeekly(score, best.get(accountId)) < 0)) {
        best.set(accountId, score);
      }
      entry.result = { ...score, ranked: !entry.practice };
      return structuredClone(entry.result);
    },
    board() {
      return Array.from(best, ([accountId, score]) => ({ accountId, ...score }))
        .sort((left, right) => compareWeekly(left, right) || left.accountId.localeCompare(right.accountId));
    },
    claim(accountId) {
      if (!claims.has(accountId)) {
        const score = best.get(accountId);
        if (!score?.objective || score.rounds > week.targetRounds) throw new Error('weekly_milestone_unearned');
        if (claims.size >= week.rewardSlots) throw new Error('weekly_budget_exhausted');
        claims.set(accountId, { id: JSON.stringify([week.id, accountId]), replayId: score.replayId, reward: week.reward ?? 'weekly-oath-cosmetic' });
      }
      return structuredClone(claims.get(accountId));
    },
    snapshot() {
      return structuredClone({ entries: [...entries], best: [...best], claims: [...claims] });
    },
  };
}

