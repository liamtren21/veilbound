import { createWeeklyOath } from './weekly.mjs';
import { createBreach } from './raid.mjs';
import { createRaidCombat } from './raid-combat.mjs';
import { openModeRepository } from './repository.mjs';
import { freshRooms, roomsAction } from '../realtime/rooms.mjs';
import { availableTrials, migrateTrialProgress, recordTalismanClear, settleTrial } from '../progression/unlocks.mjs';

const roomOperations = {
  coop: ['read', 'create', 'join', 'ready', 'act', 'presence'],
  duel: ['read', 'create', 'join', 'ready', 'act', 'resume', 'practice', 'leave'],
};
const expectedErrors = /^(weekly_|raid_|trial_|duel_|coop_|room_|ranked_|invalid_(duel|coop|presence|queue)|stale_(duel|coop))/;
const modeRoute = /^\/api\/modes\/(weekly|raid|trials|coop|duel|rewards)(?:\/([\w-]+))?(?:\/([\w-]+))?$/;

const requestError = code => Object.assign(new Error(code), { status: 409, code: code.toUpperCase() });

export function openGameModes(file, { combat, runs, week, raid, now = Date.now, rankedEnabled = false } = {}) {
  const db = openModeRepository(file);
  return {
    route({ method, path, accountId, body = {} }) {
      const match = modeRoute.exec(path);
      if (!match) return undefined;
      if (typeof accountId !== 'string' || !/^[\w-]{1,100}$/.test(accountId) ||
          ['constructor', 'prototype', '__proto__'].includes(accountId)) throw requestError('invalid_mode_account');
      const [, mode, id, suffix] = match;
      try {
        if (mode === 'rewards') return method === 'GET' && !id ? { rewards: db.rewards(accountId) } : undefined;
        if (mode === 'duel' || mode === 'coop') {
          const operation = method === 'GET' && id && !suffix ? 'read' : method === 'POST' ? suffix ?? (id === 'practice' ? 'practice' : !id && 'create') : null;
          if (!roomOperations[mode].includes(operation) || operation === 'leave' && id !== 'ranked') return undefined;
          const reply = db.update('realtime', (state, grant) => {
            state ??= freshRooms();
            try {
              const result = roomsAction(state, { mode, roomId: id, operation, accountId, body, now: now(), rankedEnabled });
              if (mode === 'coop' && result.phase === 'won') {
                const entitlements = (result.rewards ?? []).map(entry =>
                  grant({ accountId: entry.accountId, mode, milestone: result.ruleset,
                    kind: 'cosmetic', itemId: 'breach-coop-crest', evidenceId: result.id, earnedAt: now() }));
                result.entitlements = entitlements.filter(item => item.accountId === accountId);
              }
              return { state, result: { result } };
            } catch (error) {
              const actionRejected = /^(stale_(duel|coop)_action|duel_(finished|deadline|turn_owner)|coop_(planning_closed|actor_(unavailable|locked))|invalid_(duel_(die|target)|coop_action))$/;
              if (!actionRejected.test(error.message)) throw error;
              return { state, result: { error } };
            }
          });
          if (reply.error) throw reply.error;
          return reply.result;
        }
        if (mode === 'trials') {
          if (suffix || !((method === 'GET' && !id) || (method === 'POST' && ['import-clear', 'start', 'settle'].includes(id)))) return undefined;
          return db.update(JSON.stringify(['trials', accountId]), (state, grant) => {
            state ??= { progress: migrateTrialProgress(), entries: [] };
            if (id === 'import-clear') {
              if (!runs) throw requestError('trial_authority_unavailable');
              const evidence = runs.verifyCompleted(accountId, body.runId);
              if (!['expedition', 'practice'].includes(evidence.mode)) throw requestError('trial_wrong_run_mode');
              state.progress = recordTalismanClear(state.progress, { outcome: evidence.outcome, talisman: evidence.state.talisman });
            }
            if (id === 'start') {
              const trial = availableTrials(state.progress).find(trial => trial.id === body.trialId);
              if (!trial || !state.progress.clears.includes(body.talisman)) throw requestError('trial_locked');
              if (!combat) throw requestError('trial_authority_unavailable');
              const run = combat.startRun(accountId, { mode: 'trial', trialId: trial.id, talisman: body.talisman, support: body.support, exportLoot: false });
              state.entries.push({ runId: run.runId, trialId: trial.id, talisman: body.talisman });
              return { state, result: run };
            }
            if (id === 'settle') {
              const entry = state.entries.find(entry => entry.runId === body.runId);
              if (!entry || !runs) throw requestError('trial_entry_missing');
              const result = runs.verifyCompleted(accountId, entry.runId);
              if (result.mode !== 'trial' || result.challenge?.trialId !== entry.trialId ||
                  result.state.talisman !== entry.talisman) throw requestError('trial_wrong_run_binding');
              state.progress = settleTrial(state.progress, { ...entry, replayId: entry.runId, outcome: result.outcome });
            }
            const entitlements = state.progress.rewards.flatMap(({ trialId, replayId, ...items }) =>
              ['recipe', 'cosmetic', 'chronicle'].filter(kind => typeof items[kind] === 'string')
                .map(kind => grant({ accountId, mode, milestone: trialId, kind,
                  itemId: items[kind], evidenceId: replayId, earnedAt: now() })));
            return { state, result: { ...state.progress, available: availableTrials(state.progress), entitlements } };
          });
        }
        const spec = mode === 'weekly' ? week : raid;
        if (mode === 'raid' && id && (method === 'GET' && suffix === 'encounter' ||
            method === 'POST' && suffix === 'act')) {
          if (!spec) throw requestError('raid_authority_unavailable');
          return db.update(JSON.stringify(['raid', spec.id]), state => {
            if (!state) throw requestError('raid_entry_missing');
            const pinned = state.spec ?? spec;
            if (method === 'POST' && now() >= pinned.endsAt + pinned.graceMs) throw requestError('raid_grace_expired');
            const encounter = createRaidCombat(state.encounters);
            const result = method === 'GET' ? encounter.view(accountId, id) : encounter.act(accountId, id, body);
            return { state, result };
          });
        }
        const methods = mode === 'weekly' ? { board: 'GET', start: 'POST', settle: 'POST', claim: 'POST' }
          : { status: 'GET', start: 'POST', settle: 'POST' };
        if (suffix || !Object.hasOwn(methods, id) || methods[id] !== method) return undefined;
        if (!spec || mode === 'weekly' && !combat) throw requestError(mode + '_authority_unavailable');
        return db.update(JSON.stringify([mode, spec.id]), (state, grant) => {
          const pinned = state?.spec ?? spec;
          const encounters = state?.encounters ?? {};
          const starts = new Map(state?.startOperations);
          const operationId = id === 'start' ? body.operationId : undefined;
          if (operationId !== undefined && (typeof operationId !== 'string' || !/^[\w-]{8,100}$/.test(operationId))) {
            throw requestError('invalid_mode_operation');
          }
          const practice = body.practice === true;
          const key = operationId === undefined ? null : JSON.stringify([accountId, operationId]);
          const retry = key === null ? undefined : starts.get(key);
          if (retry) {
            if (retry.practice !== practice) throw requestError('mode_operation_conflict');
            return { state, result: retry.result };
          }
          const service = mode === 'weekly' ? createWeeklyOath({ week: pinned, combat, now, snapshot: state?.snapshot })
            : createBreach({ event: pinned, combat: createRaidCombat(encounters), now, snapshot: state?.snapshot });
          const result = id === 'start' ? service.start(accountId, { practice })
            : id === 'settle' ? service.settle(accountId, body.runId)
            : service[id](accountId);
          if (mode === 'weekly' && (id === 'claim' || id === 'settle' && result.ranked)) {
            if (id === 'settle') result.milestoneChecked = true;
            try {
              const reward = id === 'claim' ? result : service.claim(accountId);
              result.entitlement = grant({ accountId, mode, milestone: pinned.id, kind: 'cosmetic',
                itemId: reward.reward, evidenceId: reward.replayId, earnedAt: now() });
            } catch (error) {
              if (id === 'claim' || !['weekly_milestone_unearned', 'weekly_budget_exhausted'].includes(error.message)) throw error;
            }
          }
          if (mode === 'raid' && id === 'settle' && result.rewardId) {
            result.entitlement = grant({ accountId, mode, milestone: pinned.id, kind: 'cosmetic',
              itemId: 'breach-contributor', evidenceId: result.replayId, earnedAt: now() });
          }
          if (key !== null) starts.set(key, { practice, result });
          return { state: { spec: pinned, snapshot: service.snapshot(), encounters, startOperations: [...starts] }, result };
        });
      } catch (error) {
        if (error.status) throw error;
        if (expectedErrors.test(error.message)) throw requestError(error.message);
        throw error;
      }
    },
    close: db.close,
  };
}
