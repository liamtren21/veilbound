import { readFileSync } from 'node:fs';

const day = 86_400_000;
const readConfig = file => JSON.parse(readFileSync(new URL('../../../config/' + file, import.meta.url), 'utf8'));

function windowFor(kind, file, start) {
  if (!start) return undefined;
  const startsAt = Date.parse(start);
  if (!Number.isFinite(startsAt) || new Date(startsAt).toISOString() !== start) {
    throw new Error('Expected an explicit UTC event timestamp such as 2026-11-12T00:00:00.000Z');
  }
  const { durationDays, graceMinutes, ...settings } = readConfig(file);
  const id = kind + '-' + new Date(startsAt).getTime();
  return { ...settings, id, startsAt, endsAt: startsAt + durationDays * day, graceMs: graceMinutes * 60_000 };
}

export function gameModeConfig(env) {
  return {
    rankedEnabled: env.VEILBOUND_RANKED_DUEL_ENABLED === 'true',
    week: windowFor('weekly', 'weekly.json', env.VEILBOUND_WEEKLY_START),
    raid: windowFor('breach', 'raids.json', env.VEILBOUND_RAID_START),
  };
}

export function expeditionModeCombat(runs) {
  const synchronous = result => {
    if (result && typeof result.then === 'function') {
      throw new Error('Mode transactions require the SQLite run repository');
    }
    return result;
  };
  return {
    startRun(accountId, spec) {
      return synchronous(runs.startMode(accountId, spec));
    },
    verifyRun(accountId, runId, expected) {
      const run = synchronous(runs.verifyCompleted(accountId, runId));
      const binding = run.challenge;
      if (run.mode !== 'weekly' || !binding || Object.entries(expected).some(([key, value]) => binding[key] !== value)) {
        throw new Error('weekly_wrong_run_binding');
      }
      return { ...run.summary, objective: run.outcome === 'won', replayId: run.runId };
    },
  };
}
