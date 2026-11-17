import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { newRun } from '../../../expedition-rules.mjs';
import { heroes, map, regions } from '../../../expedition-data.mjs';
import { dialogueContext, recordStoryMemory } from '../npc/context.mjs';
import { companionForHero } from '../../../expedition-companions.mjs';
import { freshProgress, settleRun, talismans, talismanStats, talismanUnlocked } from '../../../expedition-progression.mjs';
import { applyCombatIntent, COMBAT_VERSION, seededValue, validateIntent } from '../combat/resolve.mjs';
import { openSqliteRunRepository } from './repository.mjs';
import { generateMap, MAP_VERSION } from '../../../shared/map-generator.mjs';
import { isTerminal, lifecycleFor } from '../../../shared/run-lifecycle.mjs';
import { runItemProvenance } from '../../../shared/inventory-provenance.mjs';
import { applyRunCopperCheckpoint } from '../../../shared/run-copper.mjs';
import { ownedPackKey } from './owned-items.mjs';
import { accountForPurse, validateVaultPurseCarry } from './vault-purse.mjs';
import { MATERIAL_REWARD_VERSION, trackMaterials } from './material-entitlements.mjs';
import accordTrials from '../../../config/accord-trials.json' with { type: 'json' };

export class RunError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const fail = (code, status) => { throw new RunError(code, status); };
const validOperation = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(id);
const json = value => JSON.parse(JSON.stringify(value));
const canonical = value => JSON.stringify(value, (_key, data) => {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return Object.fromEntries(Object.keys(data).sort().map(key => [key, data[key]]));
  }
  return data;
});
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const runHash = (run, state, metrics, checkpoints) => hash({
  runId: run.runId, ruleset: run.ruleset, graph: run.graph, state, metrics, checkpoints,
});
const bossRegions = new Map(regions.map(region => [region.boss, region.number]));
const baseMetrics = () => ({ bossClears: 0, rounds: 0, faints: 0, consumables: 0, lostCopperAtomic: '0' });

function publicRun(run, action = run.lastAction ?? null) {
  const state = json(run.state);
  delete state.seed;
  delete state.economySeed;
  if (state.battle) delete state.battle.rng;
  return json({
    runId: run.runId, mode: run.mode, ruleset: run.ruleset, version: run.version,
    stateHash: run.stateHash, lifecycle: lifecycleFor(state), state, action,
    availableNodes: state.phase === 'map' ? run.graph.nodes[state.node]?.next.map(id => ({
      id, risk: run.graph.nodes[id].risk,
    })) ?? [] : [],
    summary: run.summary,
    rewardReservation: run.rewardReservation ?? null,
    challenge: run.challenge ?? null,
    loadoutPreparation: {
      purseAtomic: run.vaultPurse?.amount ?? null,
      ownedItems: run.ownedItems ? Object.fromEntries(run.ownedItems.token_ids.map((id, index) =>
        [id, run.ownedItems.amounts[index]])) : null,
      chronicleToken: run.chronicleBinding?.tokenId ?? null,
    },
    checkpoints: run.checkpoints,
    provenance: runItemProvenance(run.mode, { tutorial: state.tutorial.enabled }),
  });
}

function runFor(account, runId) {
  if (!Object.hasOwn(account.runs, runId)) fail('RUN_NOT_FOUND', 404);
  return account.runs[runId];
}

function validateAccount(accountId) {
  if (typeof accountId !== 'string' || accountId.length === 0 || accountId.length > 256) {
    fail('INVALID_ACCOUNT', 400);
  }
}

function consumeMetric(intent) {
  return Number(intent.type === 'salve' || intent.type === 'use-remedy' ||
    (intent.type === 'use-die' && intent.dieId === 'reserve'));
}

function advance(run, before, intent, sequence, priorMetrics, priorCheckpoints) {
  const state = json(before);
  if (intent.type === 'move-equipment' && intent.heroKey === state.starterRelic?.heroKey &&
      intent.slot === state.starterRelic.slot) return null;
  if (intent.type === 'bind-vault-purse' || intent.type === 'cancel-vault-purse') {
    if (!run.vaultPurse || sequence !== 1) return null;
    const amount = Number(run.vaultPurse.amount) / 100;
    const cancelled = intent.type === 'cancel-vault-purse';
    state.copper += cancelled ? 0 : amount;
    state.vaultPurse = { remaining: cancelled ? 0 : amount, returned: cancelled ? amount : 0, spent: 0, lost: 0 };
    if (cancelled) state.phase = 'defeat';
    return { state, action: null, metrics: priorMetrics, checkpoints: priorCheckpoints };
  }
  if (intent.type === 'cancel-owned-items') {
    if (!run.ownedItems || sequence !== 1) return null;
    state.phase = 'defeat';
    state.ownedRemaining = Object.fromEntries(run.ownedItems.token_ids.map((id, index) => [id, Number(run.ownedItems.amounts[index])]));
    return { state, action: null, metrics: priorMetrics, checkpoints: priorCheckpoints };
  }
  if (intent.type === 'bind-owned-items') {
    const receipt = run.ownedItems;
    if (!receipt || sequence !== 1 || intent.reservationId !== receipt.reservation_id) return null;
    state.ownedRemaining = {};
    receipt.token_ids.forEach((id, index) => {
      const key = ownedPackKey(id);
      const count = Number(receipt.amounts[index]);
      state.pack[key] = (state.pack[key] ?? 0) + count;
      state.ownedRemaining[id] = count;
    });
    return { state, action: null, metrics: priorMetrics, checkpoints: priorCheckpoints };
  }
  const action = applyCombatIntent(state, intent, { secret: run.secret, sequence, graph: run.graph });
  if (!action) return null;
  if (before.starterInventory) {
    const starter = state.starterInventory;
    const temporaryCopper = before.copper - before.starterInventory.copper;
    starter.copper -= Math.max(0, before.starterInventory.copper - state.copper);
    for (const id of starter.tokenIds) {
      const key = ownedPackKey(id);
      starter.remaining[id] = Math.min(starter.remaining[id], state.pack[key] ?? 0);
    }
    if (temporaryCopper < 0) throw new Error('Starter Copper exceeds the run balance');
  }
  for (const [id, remaining] of Object.entries(before.ownedRemaining ?? {})) {
    const key = ownedPackKey(id);
    state.ownedRemaining[id] = Math.min(remaining, state.pack[key] ?? 0);
  }
  const metrics = { ...priorMetrics };
  const checkpoints = [...priorCheckpoints];
  const bossRegion = bossRegions.get(before.node);
  const boss = intent.type === 'claim' && intent.choice === 'leave' && bossRegion
    ? { region: bossRegion, node: before.node } : null;
  const starterCopper = state.starterInventory?.copper ?? 0;
  const copper = applyRunCopperCheckpoint({ ...state, copper: state.copper - starterCopper }, boss);
  accountForPurse(before, state, copper.checkpoint);
  state.copper = copper.remaining + (['complete', 'defeat'].includes(state.phase) ? 0 : starterCopper);
  if (run.ruleset.materials === MATERIAL_REWARD_VERSION) {
    trackMaterials({ before, after: state, node: run.graph.nodes[before.node], runId: run.runId,
      sequence, checkpoint: copper.checkpoint });
  }
  if (copper.checkpoint) {
    checkpoints.push(copper.checkpoint);
    metrics.bossClears++;
  }
  if (state.phase === 'defeat') metrics.lostCopperAtomic = String(BigInt(copper.lostCopperAtomic) - BigInt(state.vaultPurse?.lost ?? 0) * 100n);
  const priorRound = before.battle?.round ?? 0;
  const nextRound = state.battle?.round ?? 0;
  if (nextRound > priorRound) metrics.rounds += nextRound - priorRound;
  metrics.faints += before.heroes.filter(hero =>
    hero.hp > 0 && !state.heroes.find(next => next.key === hero.key)?.hp).length;
  metrics.consumables += consumeMetric(intent);
  return { state, action: json(action), metrics, checkpoints };
}

function calculateReplay(run, observeFrame) {
  let state = run.initialState;
  let metrics = baseMetrics();
  let checkpoints = [];
  let version = 0;
  const observations = [];
  let stateHash = runHash(run, state, metrics, checkpoints);
  if (stateHash !== run.initialHash) fail('RUN_REPLAY_MISMATCH', 500);
  for (const event of run.events) {
    if (event.sequence !== version + 1 || event.previousHash !== stateHash) fail('RUN_REPLAY_MISMATCH', 500);
    const result = advance(run, state, event.intent, event.sequence, metrics, checkpoints);
    if (!result) fail('RUN_REPLAY_MISMATCH', 500);
    if (state.phase === 'battle' && result.state.phase === 'reward') {
      observations.push({ sequence: event.sequence, kind: 'encounter-clear', node: state.node });
    }
    if (event.intent.type === 'salve') {
      observations.push({ sequence: event.sequence, kind: 'salve-heal', node: state.node });
    }
    if (state.node === 'memorial' && event.intent.type === 'event' && event.intent.choice === 'remember') {
      observations.push({ sequence: event.sequence, kind: 'remember-names', node: state.node });
    }
    if (result.checkpoints.length > checkpoints.length) {
      observations.push({ sequence: event.sequence, kind: 'checkpoint', node: state.node });
    }
    ({ state, metrics, checkpoints } = result);
    stateHash = runHash(run, state, metrics, checkpoints);
    if (stateHash !== event.stateHash) fail('RUN_REPLAY_MISMATCH', 500);
    version = event.sequence;
    observeFrame?.(state, event.intent, version);
  }
  if (stateHash !== run.stateHash || version !== run.version ||
    runHash(run, run.state, run.metrics, run.checkpoints) !== run.stateHash) fail('RUN_REPLAY_MISMATCH', 500);
  return { state, stateHash, version, observations };
}

const currentRun = account => Object.values(account.runs).reverse().find(run =>
  ['practice', 'expedition'].includes(run.mode) && !isTerminal(lifecycleFor(run.state)));

export function createRunService({ repository, modeSecret, entropy = randomBytes, rewards, materialClaims, ownedItems, vaultPurse, allowNewVaultPurse = Boolean(vaultPurse), starter, storyVersion } = {}) {
  async function flushStarterSpend(player) {
    const pending = await repository.read(player, account => account.pendingStarterSpend);
    if (!pending) return;
    try { await starter.settleRun(player, pending); }
    catch { fail('STARTER_SPEND_PENDING', 409); }
    await repository.update(player, account => {
      if (account.pendingStarterSpend?.run_id === pending.run_id) delete account.pendingStarterSpend;
    });
  }
  if (!repository) throw new TypeError('Expected a run repository');
  return {
    loadoutCapabilities: () => ({ purse: Boolean(vaultPurse) && allowNewVaultPurse, items: Boolean(ownedItems) }),
    expeditionRunId(player, operationId) {
      if (!validOperation(operationId)) fail('INVALID_OPERATION', 400);
      return hash(['rewarded-run', player, operationId]);
    },
    async prepareStarterClaim(player, accountId) {
      if (starter?.canClaim?.() === false) fail('STARTER_CLAIM_UNAVAILABLE', 409);
      if (!starter?.hasGrant(player)) fail('STARTER_CLAIM_PENDING', 409);
      await flushStarterSpend(player);
      await repository.update(player, account => {
        if (account.pendingStarterSpend) fail('STARTER_SPEND_PENDING', 409);
        if (currentRun(account)?.state.starterRelic) fail('FINISH_ACTIVE_RUN_BEFORE_CLAIM', 409);
        // A prepared wallet transaction can be signed later. Disable further custody
        // use before returning any claim transaction, including after a restart.
        account.starterClaimStarted = true;
      });
      return starter.prepareClaim(player, accountId);
    },
    prepareVaultPurse(player, runId, amount) {
      if (!vaultPurse) fail('VAULT_PURSE_UNAVAILABLE', 409);
      if (validateVaultPurseCarry(amount) !== 'VAULT_PURSE_UNAVAILABLE') fail('INVALID_PURSE_CARRY', 400);
      return repository.update(player, account => {
        const run = runFor(account, runId);
        if (run.mode !== 'expedition' || !run.rewardReservation?.beneficiary || run.version !== 0 || run.ownedItems) {
          fail('VAULT_PURSE_PREPARATION_CLOSED', 409);
        }
        if (!run.vaultPurse && !allowNewVaultPurse) fail("VAULT_PURSE_UNAVAILABLE", 409);
        if (run.vaultPurse && run.vaultPurse.amount !== amount) fail('VAULT_PURSE_CONFLICT', 409);
        run.vaultPurse ??= vaultPurse.receipt(run, amount);
        return vaultPurse.reserve(run.vaultPurse);
      });
    },
    async confirmVaultPurse(player, runId, { cancel = false } = {}) {
      if (!vaultPurse) fail('VAULT_PURSE_UNAVAILABLE', 409);
      const reservation = await repository.read(player, account => runFor(account, runId).vaultPurse);
      if (!reservation || !cancel && !await vaultPurse.confirmed(reservation)) fail('VAULT_PURSE_PENDING', 409);
      return repository.update(player, account => {
        const run = runFor(account, runId);
        const type = cancel ? 'cancel-vault-purse' : 'bind-vault-purse';
        if (run.events[0]?.intent.type === type) return publicRun(run);
        if (run.version !== 0 || hash(reservation) !== hash(run.vaultPurse)) fail('VAULT_PURSE_CONFLICT', 409);
        const intent = { type };
        const previousHash = run.stateHash;
        run.state = advance(run, run.state, intent, 1, run.metrics, run.checkpoints).state;
        run.version = 1;
        run.stateHash = runHash(run, run.state, run.metrics, run.checkpoints);
        run.events.push({ sequence: 1, previousHash, stateHash: run.stateHash, intent });
        if (cancel) run.summary = { outcome: 'lost', ...run.metrics };
        return publicRun(run);
      });
    },
    prepareVaultPurseClose(player, runId) {
      if (!vaultPurse) fail('VAULT_PURSE_UNAVAILABLE', 409);
      return repository.read(player, account => {
        const run = runFor(account, runId);
        const replay = calculateReplay(run);
        if (!isTerminal(lifecycleFor(replay.state)) || !run.vaultPurse || !replay.state.vaultPurse) fail('VAULT_PURSE_CLOSE_UNAVAILABLE', 409);
        return vaultPurse.close(run.vaultPurse, replay.version, replay.state.vaultPurse);
      });
    },
    prepareOwnedItems(player, runId, items) {
      if (!ownedItems) fail('RUN_ITEMS_UNAVAILABLE', 409);
      return repository.update(player, account => {
        const run = runFor(account, runId);
        if (run.mode !== 'expedition' || !run.rewardReservation || run.version !== 0 || run.vaultPurse) fail('RUN_ITEMS_PREPARATION_CLOSED', 409);
        const receipt = ownedItems.prepare(run, items);
        if (!receipt) fail('INVALID_RUN_ITEMS', 422);
        if (run.ownedItems && (hash(receipt.token_ids) !== hash(run.ownedItems.token_ids) ||
            hash(receipt.amounts) !== hash(run.ownedItems.amounts))) fail('RUN_ITEMS_CONFLICT', 409);
        run.ownedItems ??= receipt;
        return ownedItems.reserve(run.ownedItems);
      });
    },
    async confirmOwnedItems(player, runId) {
      if (!ownedItems) fail('RUN_ITEMS_UNAVAILABLE', 409);
      const receipt = await repository.read(player, account => runFor(account, runId).ownedItems);
      if (!receipt || !await ownedItems.confirmed(receipt)) fail('RUN_ITEMS_RESERVATION_PENDING', 409);
      return repository.update(player, account => {
        const run = runFor(account, runId);
        if (run.version > 0) return publicRun(run);
        const intent = { type: 'bind-owned-items', reservationId: receipt.reservation_id };
        const previousHash = run.stateHash;
        const result = advance(run, run.state, intent, 1, run.metrics, run.checkpoints);
        if (!result) fail('RUN_ITEMS_CONFLICT', 409);
        run.state = result.state;
        run.version = 1;
        run.stateHash = runHash(run, run.state, run.metrics, run.checkpoints);
        run.events.push({ sequence: 1, previousHash, stateHash: run.stateHash, intent });
        return publicRun(run);
      });
    },
    prepareOwnedItemsClose(player, runId) {
      if (!ownedItems) fail('RUN_ITEMS_UNAVAILABLE', 409);
      return repository.read(player, account => {
        const run = runFor(account, runId);
        const replay = calculateReplay(run);
        if (!isTerminal(lifecycleFor(replay.state)) || !run.ownedItems || !replay.state.ownedRemaining) fail('RUN_ITEMS_CLOSE_UNAVAILABLE', 409);
        const receipt = run.ownedItems;
        const consumed = receipt.token_ids.map((id, i) => String(Number(receipt.amounts[i]) - replay.state.ownedRemaining[id]));
        return ownedItems.close(receipt, consumed, replay.version);
      });
    },
    cancelOwnedItems(player, runId) {
      if (!ownedItems) fail('RUN_ITEMS_UNAVAILABLE', 409);
      return repository.update(player, account => {
        const run = runFor(account, runId);
        if (run.events[0]?.intent.type === 'cancel-owned-items') return publicRun(run);
        if (!run.ownedItems || run.version !== 0) fail('RUN_ITEMS_PREPARATION_CLOSED', 409);
        const intent = { type: 'cancel-owned-items' };
        const previousHash = run.stateHash;
        run.state = advance(run, run.state, intent, 1, run.metrics, run.checkpoints).state;
        run.version = 1;
        run.stateHash = runHash(run, run.state, run.metrics, run.checkpoints);
        run.events.push({ sequence: 1, previousHash, stateHash: run.stateHash, intent });
        run.summary = { outcome: 'lost', ...run.metrics };
        return publicRun(run);
      });
    },
    start(accountId, { mode = 'practice', talisman = 'gate', operationId, tutorial = false, chronicleBinding, purseAtomic = '0', nftBinding } = {}) {
      validateAccount(accountId);
      if (nftBinding && mode === 'expedition' && (!nftBinding.expiresAtNs ||
          BigInt(nftBinding.expiresAtNs) <= BigInt(Date.now()) * 1000000n)) fail('NFT_RUN_LOCK_REQUIRED', 409);
      const purseError = validateVaultPurseCarry(purseAtomic);
      if (purseError === 'INVALID_PURSE_CARRY') fail(purseError, 400);
      const carriesCopper = purseAtomic !== '0';
      if (carriesCopper && (!vaultPurse || !allowNewVaultPurse || mode !== 'expedition')) fail('VAULT_PURSE_UNAVAILABLE', 409);
      if (mode !== 'practice' && mode !== 'expedition') fail('INVALID_MODE', 400);
      if (mode === 'expedition' && !rewards) fail('REWARD_RESERVATION_UNAVAILABLE', 409);
      if (mode === 'expedition' && tutorial) fail('INVALID_LOADOUT', 400);
      if (mode === 'expedition' && !validOperation(operationId)) fail('INVALID_OPERATION', 400);
      if (!talismans.some(item => item.id === talisman) || typeof tutorial !== 'boolean') fail('INVALID_LOADOUT', 400);
      if (mode === 'expedition' && rewards.needsRefresh?.()) {
        return rewards.refresh().then(() => this.start(accountId, { mode, talisman, operationId, tutorial, chronicleBinding, purseAtomic, nftBinding }));
      }
      if (operationId !== undefined && !validOperation(operationId)) fail('INVALID_OPERATION', 400);
      const nftIdentity = binding => {
        const { expiresAtNs, companionRules, ...identity } = binding ?? {};
        return hash(identity);
      };
      const fingerprint = hash({ mode, talisman, tutorial, chronicleToken: chronicleBinding?.tokenId,
        ...(carriesCopper ? { purseAtomic } : {}), ...(nftBinding ? { nftIdentity: nftIdentity(nftBinding) } : {}) });
      const start = () => repository.update(accountId, account => {
        if (account.pendingStarterSpend) fail('STARTER_SPEND_PENDING', 409);
        const retry = operationId && Object.hasOwn(account.startOperations, operationId)
          ? account.startOperations[operationId] : null;
        if (retry) {
          if (retry.fingerprint !== fingerprint) fail('OPERATION_CONFLICT', 409);
          if (mode === 'expedition' && nftBinding?.expiresAtNs) {
            const existing = runFor(account, retry.response.runId);
            if (nftIdentity(existing.state.nftLoadout) !== nftIdentity(nftBinding)) fail('NFT_LOADOUT_CHANGED', 409);
            if (BigInt(nftBinding.expiresAtNs) > BigInt(existing.nftLockExpiresAtNs ?? existing.state.nftLoadout.expiresAtNs)) {
              existing.nftLockExpiresAtNs = nftBinding.expiresAtNs;
            }
            return publicRun(existing);
          }
          return retry.response;
        }
        account.progress[mode] ??= freshProgress();
        let run = currentRun(account);
        if (run && nftBinding && nftIdentity(run.state.nftLoadout) !== nftIdentity(nftBinding)) fail('NFT_LOADOUT_CHANGED', 409);
        if (run && run.mode !== mode) fail('RUN_MODE_CONFLICT', 409);
        if (run && carriesCopper && run.vaultPurse?.amount !== purseAtomic) fail('VAULT_PURSE_CONFLICT', 409);
        if (!run) {
          const progress = account.progress[mode];
          if (!talismanUnlocked(progress, talisman) || tutorial && talisman !== 'gate') fail('INVALID_LOADOUT', 400);
          const starterRelic = mode === 'practice' && !account.starterClaimStarted ? starter?.relicForRun(accountId) : null;
          run = addRun(account, {
            mode, talisman, tutorial, xp: talismanStats(progress, talisman).xp, secret: entropy(32).toString('hex'),
            runId: mode === 'expedition' ? hash(['rewarded-run', accountId, operationId]) : undefined,
            starterRelic, starterInventory: starterRelic ? starter.inventoryForRun?.(accountId) : null,
            nftBinding, storyVersion,
          });
          if (mode === 'expedition') {
            run.rewardReservation = rewards.reserve(accountId, run.runId);
            if (nftBinding && nftBinding.accountId !== run.rewardReservation.beneficiary) fail('NFT_LOADOUT_CHANGED', 409);
            if (carriesCopper) run.vaultPurse = vaultPurse.receipt(run, purseAtomic);
            if (chronicleBinding) {
              if (chronicleBinding.accountId !== run.rewardReservation.beneficiary) fail('RELIC_BINDING_CHANGED', 409);
              run.chronicleBinding = json(chronicleBinding);
            }
          }
          account.expeditionRunId = run.runId;
        }
        const response = publicRun(run);
        if (operationId) account.startOperations[operationId] = { fingerprint, response };
        return response;
      });
      if (!starter?.settleRun) return start();
      const pending = repository.read(accountId, account => Boolean(account.pendingStarterSpend));
      if (pending && typeof pending.then === 'function') {
        return pending.then(exists => exists ? flushStarterSpend(accountId).then(start) : start());
      }
      return pending ? flushStarterSpend(accountId).then(start) : start();
    },
    startMode(accountId, spec) {
      validateAccount(accountId);
      if (spec?.mode === 'trial') {
        const { trialId, talisman, support, exportLoot } = spec;
        const accordTrial = accordTrials.find(trial => trial.id === trialId);
        const validSupport = accordTrial?.supportChoice ? ['salve', 'bark-shield'].includes(support) : support === undefined;
        if (!accordTrial || !validSupport || !talismans.some(item => item.id === talisman) ||
          exportLoot !== false) fail('INVALID_MODE_LOADOUT', 400);
        return repository.update(accountId, account => publicRun(addRun(account, {
          mode: 'trial', talisman, tutorial: false, xp: 0, secret: entropy(32).toString('hex'),
          challenge: { trialId, talisman, support: support ?? null }, accordTrial, accordSupport: support,
        })));
      }
      if (spec?.mode !== 'weekly') fail('MODE_ADAPTER_UNAVAILABLE', 409);
      if (!Buffer.isBuffer(modeSecret) || modeSecret.length < 32) fail('MODE_ADAPTER_UNAVAILABLE', 409);
      const { weeklyId, seed, ruleset, roster, budget, practice = false, exportLoot } = spec;
      if (!validOperation(weeklyId) || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff ||
        !validOperation(ruleset) || !Array.isArray(roster) || roster.length !== 3 || new Set(roster).size !== 3 ||
        roster.some(id => !heroes.some(hero => hero.id === id)) || budget !== 0 ||
        typeof practice !== 'boolean' || exportLoot !== false) fail('INVALID_MODE_LOADOUT', 400);
      const challenge = { weeklyId, seed, ruleset, roster, budget };
      const secret = createHmac('sha256', modeSecret).update(canonical(challenge)).digest('hex');
      return repository.update(accountId, account => publicRun(addRun(account, {
        mode: 'weekly', talisman: 'gate', tutorial: false, xp: 0, secret,
        challenge: { weeklyId, ruleset, practice }, roster,
      })));
    },
    async supplyStatus(player, runId) {
      validateAccount(player);
      const receipts = await repository.read(player, account => {
        const run = runFor(account, runId);
        return { purse: run.vaultPurse, items: run.ownedItems };
      });
      const [purse, items] = await Promise.all([
        receipts.purse && vaultPurse ? vaultPurse.settlement(receipts.purse) : null,
        receipts.items && ownedItems ? ownedItems.settlement(receipts.items) : null,
      ]);
      return { purse, items };
    },
    expeditionHistory(player) {
      validateAccount(player);
      return repository.read(player, account => Object.values(account.runs).reverse()
        .filter(run => run.mode === 'expedition' && isTerminal(lifecycleFor(run.state)) &&
          (run.checkpoints.length || run.vaultPurse || run.ownedItems || run.chronicleBinding))
        .map(run => ({ runId: run.runId, outcome: run.summary?.outcome ?? lifecycleFor(run.state),
          talisman: run.state.talisman, version: run.version })));
    },
    active(accountId) {
      validateAccount(accountId);
      return repository.read(accountId, account => {
        const run = currentRun(account) ?? account.runs[account.expeditionRunId] ??
          Object.values(account.runs).reverse().find(run => ['practice', 'expedition'].includes(run.mode));
        return run ? publicRun(run) : null;
      });
    },
    dialogueContext(accountId, runId) {
      validateAccount(accountId);
      return repository.read(accountId, account => dialogueContext(runFor(account, runId), account.storyMemory));
    },
    get(accountId, runId) {
      validateAccount(accountId);
      return repository.read(accountId, account => publicRun(runFor(account, runId)));
    },
    act(accountId, runId, request) {
      validateAccount(accountId);
      const { operationId, expectedVersion, intent } = request ?? {};
      if (!validOperation(operationId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 ||
        Object.keys(request).length !== 3) fail('INVALID_OPERATION', 400);
      const fingerprint = hash({ expectedVersion, intent });
      return repository.update(accountId, account => {
        const run = runFor(account, runId);
        if (Object.hasOwn(run.operations, operationId)) {
          const retry = run.operations[operationId];
          if (retry.fingerprint !== fingerprint) fail('OPERATION_CONFLICT', 409);
          return retry.response;
        }
        if (run.version !== expectedVersion) fail('STALE_VERSION', 409);
        const lockExpiry = run.nftLockExpiresAtNs ?? run.state.nftLoadout?.expiresAtNs;
        if (run.mode === 'expedition' && lockExpiry &&
            BigInt(lockExpiry) <= BigInt(Date.now()) * 1000000n) fail('NFT_RUN_LOCK_EXPIRED', 409);
        if (run.ownedItems && run.version === 0) fail('RUN_ITEMS_RESERVATION_PENDING', 409);
        if (run.vaultPurse && run.version === 0) fail('VAULT_PURSE_PENDING', 409);
        if (isTerminal(lifecycleFor(run.state))) fail('RUN_CLOSED', 409);
        if (!validateIntent(intent) || run.mode === 'weekly' && intent.type === 'configure') fail('INVALID_ACTION', 422);
        const sequence = run.version + 1;
        const previousHash = run.stateHash;
        const result = advance(run, run.state, intent, sequence, run.metrics, run.checkpoints);
        if (!result) fail('INVALID_ACTION', 422);
        ({ state: run.state, metrics: run.metrics, checkpoints: run.checkpoints } = result);
        run.version = sequence;
        run.stateHash = runHash(run, run.state, run.metrics, run.checkpoints);
        run.events.push({ sequence, previousHash, stateHash: run.stateHash, intent });
        if (intent.type === 'event') recordStoryMemory(account, run, intent.choice);
        if (isTerminal(lifecycleFor(run.state))) {
          if (run.initialState.starterInventory) {
            const initial = run.initialState.starterInventory;
            const final = run.state.starterInventory;
            const copper = (initial.copper - final.copper) * 100;
            const quantities = initial.tokenIds.map(id => String(initial.remaining[id] - final.remaining[id]));
            if (copper > 0 || quantities.some(amount => amount !== '0')) {
              account.pendingStarterSpend = { grant_id: run.state.starterRelic.grantId, run_id: runId,
                copper: String(copper), quantities };
            }
          }
          const progress = ['practice', 'expedition'].includes(run.mode)
            ? settleRun(account.progress[run.mode], run.state) : null;
          run.summary = { outcome: run.state.phase === 'complete' ? 'won' : 'lost', progress, ...run.metrics };
        }
        const response = publicRun(run, result.action);
        run.lastAction = result.action;
        run.operations[operationId] = { fingerprint, response };
        return response;
      });
    },
    replay(accountId, runId) {
      validateAccount(accountId);
      return repository.read(accountId, account => {
        const run = runFor(account, runId);
        calculateReplay(run);
        return json({
          verified: true, runId, ruleset: run.ruleset, initialHash: run.initialHash,
          stateHash: run.stateHash, events: run.events,
        });
      });
    },
    journeyProof(accountId, runId) {
      validateAccount(accountId);
      return repository.read(accountId, account => {
        const run = runFor(account, runId);
        if (!run.summary || !isTerminal(lifecycleFor(run.state))) fail('RUN_NOT_COMPLETE', 409);
        const frames = [];
        const units = members => members.map(({ name, hp, maxHp, ward }) =>
          ({ name, hp, maxHp, defense: ward ?? 0 }));
        const { observations } = calculateReplay(run, (state, intent, sequence) => {
          frames.push({
            sequence, action: intent.type, location: map[state.node].name, phase: state.phase,
            report: state.report, party: units(state.heroes), enemies: units(state.battle?.enemies ?? []),
          });
        });
        return { ...publicRun(run), outcome: run.summary.outcome, observations, frames };
      });
    },
    startJourneyChallenge(player, sourcePlayer, sourceRun, journeyId) {
      validateAccount(player);
      const settings = repository.read(sourcePlayer, account => {
        const source = runFor(account, sourceRun);
        if (!source.summary || !isTerminal(lifecycleFor(source.state))) fail('RUN_NOT_COMPLETE', 409);
        return {
          talisman: source.initialState.talisman,
          tutorial: Boolean(source.initialState.tutorial?.enabled),
          storyVersion: source.initialState.storyVersion ?? 0,
          graph: source.graph,
        };
      });
      const start = ({ talisman, tutorial, storyVersion, graph }) => repository.update(player, account => {
        const active = Object.values(account.runs).find(run =>
          run.mode === 'journey' && run.challenge?.journeyId === journeyId && !isTerminal(lifecycleFor(run.state)));
        return publicRun(active ?? addRun(account, {
          mode: 'journey', talisman, tutorial, storyVersion, xp: 0, graph,
          secret: entropy(32).toString('hex'), challenge: { journeyId },
        }));
      });
      return settings?.then ? settings.then(start) : start(settings);
    },
    async prepareBank(accountId, runId, region) {
      validateAccount(accountId);
      if (!rewards) fail('REWARD_RESERVATION_UNAVAILABLE', 409);
      const evidence = await repository.read(accountId, account => {
        const run = runFor(account, runId);
        const replay = calculateReplay(run);
        if (run.mode !== 'expedition' || !run.rewardReservation) fail('INVALID_REWARD_EVIDENCE', 422);
        return {
          runId, mode: run.mode, checkpoints: json(run.checkpoints),
          checkpointSequences: replay.observations.filter(event => event.kind === 'checkpoint').map(event => event.sequence),
        };
      });
      const payload = rewards.prepare(accountId, evidence, region);
      return rewards.reconcile ? rewards.reconcile(payload) : payload;
    },
    verifyProgress(accountId, runId) {
      validateAccount(accountId);
      return repository.read(accountId, account => {
        const run = runFor(account, runId);
        const replay = calculateReplay(run);
        return { accountId, ...publicRun(run), graph: json(run.graph), observations: replay.observations,
          chronicleBinding: run.chronicleBinding ? json(run.chronicleBinding) : null };
      });
    },
    verifyCompleted(accountId, runId) {
      validateAccount(accountId);
      return repository.read(accountId, account => {
        const run = runFor(account, runId);
        if (!run.summary) fail('RUN_NOT_COMPLETE', 409);
        calculateReplay(run);
        return { accountId, ...publicRun(run, run.lastAction), outcome: run.summary.outcome };
      });
    },
    async prepareMaterialClaim(accountId, runId, entitlementId) {
      validateAccount(accountId);
      if (!materialClaims) fail('MATERIAL_CLAIM_UNAVAILABLE', 409);
      if (typeof entitlementId !== 'string' || !/^[a-f0-9]{64}$/.test(entitlementId)) fail('INVALID_ENTITLEMENT', 400);
      const evidence = await repository.read(accountId, account => {
        const run = runFor(account, runId);
        if (run.mode !== 'expedition' || !run.rewardReservation?.beneficiary) fail('INVALID_REWARD_EVIDENCE', 422);
        const replay = calculateReplay(run);
        const checkpoint = run.checkpoints.find(row => row.materials?.some(item => item.entitlementId === entitlementId));
        const entitlement = checkpoint?.materials.find(item => item.entitlementId === entitlementId);
        const event = replay.observations.find(row => row.kind === 'checkpoint' && row.node === checkpoint?.node);
        if (!entitlement || !event) fail('MATERIAL_ENTITLEMENT_NOT_FOUND', 404);
        return { runId, node: checkpoint.node, sequence: event.sequence, entitlement,
          beneficiary: run.rewardReservation.beneficiary, prior: run.materialClaims?.[entitlementId] };
      });
      if (!evidence.prior) await materialClaims.checkBudget(evidence.entitlement.itemId, evidence.entitlement.quantity);
      const receipt = evidence.prior ?? await repository.update(accountId, account => {
        const run = runFor(account, runId);
        run.materialClaims ??= {};
        return run.materialClaims[entitlementId] ??= materialClaims.receipt(evidence);
      });
      const settled = await materialClaims.readFinal(receipt);
      return { status: settled ? 'settled' : 'prepared', receipt,
        transaction: settled ? null : materialClaims.transaction(receipt) };
    },
    materialBank(accountId, runId) {
      validateAccount(accountId);
      return repository.read(accountId, account => {
        const run = runFor(account, runId);
        calculateReplay(run);
        return {
          runId, policy: run.ruleset.materials ?? null,
          entitlements: json(run.checkpoints.flatMap(checkpoint =>
            (checkpoint.materials ?? []).map(entitlement => ({ ...entitlement, region: checkpoint.region })))),
        };
      });
    },
    close: () => repository.close?.(),
  };
}

function addRun(account, { mode, talisman, tutorial, xp, secret, challenge, roster, accordTrial, accordSupport, starterRelic, starterInventory, nftBinding, storyVersion, graph = generateMap(seededValue(secret, 0, 'map'), { tutorial }), runId = randomUUID() }) {
  const state = json(newRun(seededValue(secret, 0, 'run'), {
    runId, talisman, tutorial, xp, accordTrial, accordSupport, storyVersion,
  }));
  if (tutorial) state.tutorial.videoVersion = 1;
  if (starterRelic) {
    const hero = state.heroes.find(unit => unit.id === 'mara');
    hero.equipment[0] = 'ferryman-cord';
    state.starterRelic = { ...starterRelic, heroKey: hero.key, slot: 0 };
  }
  if (nftBinding) {
    if (nftBinding.companionId && !state.heroes.some(hero => companionForHero(hero) === nftBinding.companionId)) {
      fail('COMPANION_HERO_UNAVAILABLE', 409);
    }
    if (nftBinding.relicToken) {
      const mara = state.heroes.find(hero => hero.id === 'mara');
      if (!mara) fail('RELIC_HERO_UNAVAILABLE', 409);
      mara.equipment[0] = 'ferryman-cord';
    }
    state.nftLoadout = json(nftBinding);
  }
  if (starterInventory) {
    const { copper, token_ids: tokenIds, quantities } = starterInventory;
    const carried = Number(BigInt(copper) / 100n);
    const remaining = Object.fromEntries(tokenIds.map((id, index) => [id, Number(quantities[index])]));
    state.copper += carried;
    for (const id of tokenIds) {
      const key = ownedPackKey(id);
      if (!key || !Number.isSafeInteger(remaining[id]) || remaining[id] < 0) fail('STARTER_INVENTORY_UNAVAILABLE', 409);
      state.pack[key] = (state.pack[key] ?? 0) + remaining[id];
    }
    state.starterInventory = { copper: carried, tokenIds, remaining };
  }
  if (roster) {
    const reserve = state.heroes.find(hero => !roster.includes(hero.id));
    const order = [...roster, reserve.id];
    state.heroes.sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id));
    state.benchKey = reserve.id;
  }
  const run = {
    runId, mode, secret, graph, state, challenge, ruleset: { combat: COMBAT_VERSION, map: MAP_VERSION },
    initialState: json(state), version: 0, events: [], operations: {}, summary: null,
    metrics: baseMetrics(), checkpoints: [],
  };
  if (mode === 'expedition') run.ruleset.materials = MATERIAL_REWARD_VERSION;
  run.stateHash = run.initialHash = runHash(run, state, run.metrics, run.checkpoints);
  account.runs[runId] = run;
  return run;
}

export function openRuns(file, options = {}) {
  return createRunService({ ...options, repository: openSqliteRunRepository(file) });
}
