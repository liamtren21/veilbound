import { randomInt } from 'node:crypto';
import { isCount } from '../../../shared/scoring.mjs';
import { raidContribution } from './raid-contribution.mjs';

const day = 24 * 60 * 60 * 1000;

export function createBreach({ event, combat, now = Date.now, seed = () => randomInt(2 ** 32), snapshot }) {
  event = structuredClone(event);
  if (!event.id || !event.ruleset ||
      ![event.startsAt, event.endsAt, event.graceMs, event.hp, event.contributionCap, event.personalThreshold, event.rewardSlots].every(isCount) ||
      !event.hp || !event.contributionCap || event.endsAt <= event.startsAt) throw new Error('invalid_raid_event');
  let remainingHp = snapshot?.remainingHp ?? event.hp;
  const entries = new Map(snapshot?.entries);
  const starts = new Map(snapshot?.starts);
  const slots = new Set(snapshot?.slots);
  const rewards = new Map(snapshot?.rewards);
  return {
    start(accountId, { practice = false } = {}) {
      const timestamp = now();
      if (timestamp < event.startsAt || timestamp >= event.endsAt) throw new Error('raid_closed');
      if (!practice) {
        const pending = [...entries.values()].find(entry => entry.accountId === accountId && !entry.practice && !entry.result);
        if (pending) return structuredClone(pending);
      }
      const recent = (starts.get(accountId) ?? []).filter(start => timestamp - start < day);
      if (!practice && (recent.length >= 3 || !remainingHp)) throw new Error('raid_contribution_unavailable');
      const ratio = remainingHp / event.hp;
      const variant = ratio <= 0.35 ? 'exposed' : ratio <= 0.7 ? 'fractured' : 'sealed';
      const reserved = !practice && (slots.has(accountId) || slots.size < event.rewardSlots);
      const { runId } = combat.startRun(accountId, {
        mode: 'raid', raidId: event.id, ruleset: event.ruleset, seed: seed(), variant,
        maxRounds: 8, practice: Boolean(practice), exportLoot: false,
      });
      if (typeof runId !== 'string' || !runId || entries.has(runId)) throw new Error('invalid_run_start');
      if (!practice) starts.set(accountId, [...recent, timestamp]);
      if (reserved) slots.add(accountId);
      const entry = { runId, accountId, variant, reserved, practice: Boolean(practice) };
      entries.set(runId, entry);
      return structuredClone(entry);
    },
    settle(accountId, runId) {
      const entry = entries.get(runId);
      if (!entry || entry.accountId !== accountId) throw new Error('raid_entry_missing');
      if (entry.result) return structuredClone(entry.result);
      if (now() >= event.endsAt + event.graceMs) throw new Error('raid_grace_expired');
      const result = raidContribution(combat.verifyRun(accountId, runId), event.contributionCap, entry.practice ? 0 : remainingHp);
      remainingHp -= result.contribution;
      const earned = entry.reserved && result.personalScore >= event.personalThreshold && !rewards.has(accountId);
      const rewardId = earned ? JSON.stringify([event.id, accountId]) : null;
      if (rewardId) rewards.set(accountId, rewardId);
      entry.result = { ...result, rewardId, remainingHp, practice: entry.practice };
      return structuredClone(entry.result);
    },
    status() {
      return { id: event.id, remainingHp, totalHp: event.hp, availableSlots: event.rewardSlots - slots.size };
    },
    snapshot() {
      return structuredClone({ remainingHp, entries: [...entries], starts: [...starts], slots: [...slots], rewards: [...rewards] });
    },
  };
}

