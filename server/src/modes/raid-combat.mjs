import { randomUUID } from 'node:crypto';
import { raidPhase } from './raid-contribution.mjs';

const variants = {
  sealed: { ward: 6, bossHp: 36, attack: 4 },
  fractured: { ward: 4, bossHp: 40, attack: 5 },
  exposed: { ward: 2, bossHp: 44, attack: 6 },
};
const choices = {
  ward: ['wardbreak', 'mark', 'strike'],
  counter: ['protect', 'counter', 'strike'],
  core: ['burst', 'protect', 'strike'],
};

function initial({ variant, seed }) {
  if (!Object.hasOwn(variants, variant) || !Number.isSafeInteger(seed)) throw new Error('invalid_raid_combat_spec');
  const { ward, bossHp } = variants[variant];
  return { phase: 'active', round: 1, version: 0, ward, bossHp, partyHp: 26, objectives: [], damage: 0, marked: false, guarded: false };
}

function advance(previous, { type }, spec) {
  if (previous.phase !== 'active' || !choices[raidPhase(previous.round)].includes(type)) throw new Error('invalid_raid_action');
  const current = structuredClone(previous);
  let damage = 0;
  let objective;
  if (type === 'wardbreak') {
    current.ward = Math.max(0, current.ward - 6);
    objective = 'ward';
  } else if (type === 'mark') {
    current.marked = true;
    objective = 'mark';
  } else if (type === 'protect') {
    current.guarded = true;
    objective = 'protect';
  } else if (type === 'counter') {
    damage = current.guarded ? 7 : 4;
    if (current.guarded) objective = 'counter';
  } else if (type === 'burst') {
    damage = current.marked ? 10 : 7;
    if (!current.ward) objective = 'core';
  } else damage = 5;
  if (current.ward) damage = Math.max(0, damage - current.ward);
  damage = Math.min(current.bossHp, damage);
  current.bossHp -= damage;
  current.damage += damage;
  if (objective && !current.objectives.includes(objective)) current.objectives.push(objective);
  const heavy = (spec.seed + current.round) % 3 === 0;
  const retaliation = current.round <= 2 ? 1 : variants[spec.variant].attack + Number(heavy);
  if (current.bossHp) current.partyHp = Math.max(0, current.partyHp - (type === 'protect' ? 0 : retaliation));
  current.version++;
  if (!current.bossHp) current.phase = 'won';
  else if (!current.partyHp || current.round === 8) current.phase = 'lost';
  else current.round++;
  return current;
}

export function createRaidCombat(encounters) {
  const lookup = (accountId, runId) => {
    const entry = Object.hasOwn(encounters, runId) && encounters[runId];
    if (!entry || entry.accountId !== accountId) throw new Error('raid_entry_missing');
    return entry;
  };
  const view = (runId, entry) => ({
    runId, ...structuredClone(entry.current), variant: entry.spec.variant,
    available: entry.current.phase === 'active' ? [...choices[raidPhase(entry.current.round)]] : [],
  });
  const verify = entry => {
    let replayed = initial(entry.spec);
    for (const event of entry.events) replayed = advance(replayed, event, entry.spec);
    if (JSON.stringify(replayed) !== JSON.stringify(entry.current)) throw new Error('raid_replay_mismatch');
    return replayed;
  };
  return {
    startRun(accountId, spec) {
      if (spec.mode !== 'raid') throw new Error('raid_wrong_run_mode');
      const runId = randomUUID();
      encounters[runId] = { accountId, spec: structuredClone(spec), events: [], current: initial(spec) };
      return { runId };
    },
    act(accountId, runId, { version, type }) {
      const entry = lookup(accountId, runId);
      if (entry.current.version !== version) {
        if (Number.isSafeInteger(version) && version >= 0 && entry.events[version]?.type === type) return view(runId, entry);
        throw new Error('raid_stale_version');
      }
      const action = { type };
      entry.current = advance(entry.current, action, entry.spec);
      entry.events.push(action);
      return view(runId, entry);
    },
    view(accountId, runId) {
      return view(runId, lookup(accountId, runId));
    },
    verifyRun(accountId, runId) {
      const entry = lookup(accountId, runId);
      const result = verify(entry);
      if (result.phase === 'active') throw new Error('raid_encounter_incomplete');
      return { damage: result.damage, objectives: result.objectives, rounds: result.round, clear: result.phase === 'won', replayId: runId };
    },
  };
}
