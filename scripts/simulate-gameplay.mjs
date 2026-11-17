import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openRuns } from '../server/src/runs/service.mjs';
import { active, describe, resolve, canEndRound, shopInventory, tokenCount } from '../expedition-rules.mjs';
import { equipment, storyChoices, storyOffer, regions } from '../expedition-data.mjs';

const clone = state => {
  const copy = structuredClone(state);
  copy.seed = 1;
  copy.economySeed = 1;
  if (copy.battle) copy.battle.rng = { dice: 1, effects: 1, curse: 1 };
  return copy;
};

function utility(state) {
  const allies = state.heroes.filter(hero => !hero.bench);
  const enemies = state.battle.enemies;
  const scoreHero = hero => hero.hp > 0
    ? hero.hp * 1.6 + 100 + Math.min(hero.ward, 40) * .55 + Number(hero.guard) * 16 + (hero.boost ?? 0) * 4
    : -220;
  const scoreEnemy = enemy => enemy.hp > 0
    ? -enemy.hp * 2.5 - 90 - Math.min(enemy.ward, 30) * .7 - Number(enemy.guard) * 16 - (enemy.boost ?? 0) * 3
    : 80;
  return allies.reduce((sum, hero) => sum + scoreHero(hero), 0) +
    enemies.reduce((sum, enemy) => sum + scoreEnemy(enemy), 0) +
    (state.battle.defense.party - state.battle.defense.foe) * .7 +
    Number(state.phase === 'reward') * 1500 - Number(state.phase === 'defeat') * 10000;
}

function dieChoices(state, { includeEnemy = false } = {}) {
  const candidates = [];
  const round = state.battle.round;
  const dice = state.battle.dice.filter(die => !die.spent && (!die.optional || die.side === 'party') &&
    (includeEnemy || die.side === 'party'));
  for (const die of dice) {
    const plan = describe(state, die.id);
    if (!plan || plan.reason) continue;
    for (const target of plan.targets) {
      const intent = { type: 'use-die', dieId: die.id, round, targetKey: target.key };
      candidates.push({ intent, plan });
    }
  }
  if (!includeEnemy) {
    for (const itemId of ['salve', 'heal-all', 'full-heal-all', 'guard-token']) {
      const actor = active(state.heroes)[0]?.key;
      const plan = describe(state, 'reserve', { actor, action: itemId });
      if (!plan || plan.reason) continue;
      for (const target of plan.targets) {
        candidates.push({ intent: { type: 'use-die', dieId: 'reserve', round, targetKey: target.key, itemId }, plan });
      }
    }
  }
  return candidates;
}

function project(state, choice) {
  const copy = clone(state);
  const override = choice.intent.dieId === 'reserve'
    ? { actor: active(copy.heroes)[0].key, action: choice.intent.itemId } : undefined;
  return resolve(copy, choice.intent.dieId, choice.intent.targetKey, override) ? copy : null;
}

function combatChoice(state, passive) {
  if (passive) {
    const enemy = dieChoices(state, { includeEnemy: true }).find(choice => choice.plan.enemy);
    return enemy?.intent ?? { type: 'end-round', round: state.battle.round };
  }
  const initial = utility(state);
  const partyChoices = dieChoices(state);
  let best;
  for (const candidate of partyChoices) {
    const after = project(state, candidate);
    if (!after) continue;
    let score = utility(after);
    if (after.phase === 'battle') {
      let continuation = 0;
      for (const next of dieChoices(after)) {
        const last = project(after, next);
        if (last) continuation = Math.max(continuation, utility(last) - score);
      }
      score += continuation * .8;
    }
    // Consumables remain available for dangerous later encounters.
    if (candidate.intent.itemId) score -= 14;
    // Every usable die should be considered before mandatory enemy dice.
    if (!best || score > best.score) best = { ...candidate, score };
  }
  if (best && best.score >= initial + .01) return best.intent;
  const enemies = dieChoices(state, { includeEnemy: true }).filter(choice => choice.plan.enemy);
  if (enemies.length) {
    // Resolve the enemy action with the least projected damage first.
    return enemies.map(choice => ({ choice, score: utility(project(state, choice)) }))
      .sort((left, right) => right.score - left.score)[0].choice.intent;
  }
  if (best) return best.intent;
  if (canEndRound(state)) return { type: 'end-round', round: state.battle.round };
  throw new Error('No legal combat choice');
}

function fieldChoice(snapshot) {
  const state = snapshot.state;
  const { phase, node } = state;
  const wounded = state.heroes.filter(hero => hero.hp > 0 && hero.hp < hero.maxHp);
  if (!['battle', 'reward'].includes(phase) && state.pack.salve && wounded.some(hero => hero.hp < hero.maxHp / 2)) {
    const hero = wounded.sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
    return { type: 'salve', heroKey: hero.key };
  }
  // Equip only inventory assets obtained through prior accepted reward/shop actions.
  if (['map', 'event', 'shop', 'reward'].includes(phase)) {
    for (const hero of state.heroes.filter(hero => hero.id !== state.benchKey)) {
      const slot = hero.equipment.findIndex(item => item === null);
      const index = state.pack.equipment.findIndex(item => !equipment[item]?.curse &&
        equipment[item]?.tag !== 'Cursed' && !hero.equipment.includes(item) &&
        !hero.equipment.some(owned => owned && (equipment[owned]?.baseId ?? owned) === (equipment[item]?.baseId ?? item)));
      if (slot >= 0 && index >= 0) return { type: 'move-equipment', heroKey: hero.key, slot, index };
    }
  }
  if (phase === 'reward') {
    const offer = state.battle.rewardOffer;
    if (offer?.copper) return { type: 'claim', choice: 'copper' };
    if (offer?.token && tokenCount(state) < 5) {
      return { type: 'claim', choice: 'token' };
    }
    const gear = offer?.gear?.find(item => !equipment[item]?.curse && equipment[item]?.tag !== 'Cursed');
    if (gear && state.pack.equipment.length < 5) return { type: 'claim', choice: 'equipment', heroKey: gear };
    if (offer?.instant) {
      const recipient = state.heroes.filter(hero => hero.hp > 0).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
      return { type: 'claim', choice: 'instant', heroKey: recipient.key };
    }
    return { type: 'claim', choice: 'leave' };
  }
  if (phase === 'shop') {
    const useful = shopInventory(state).find(item =>
      ['salve', 'resin-buckle', 'juniper-beads', 'ferryman-cord'].includes(item.id) &&
      !state.bought[state.node + ':' + item.id] && state.copper >= item.price &&
      (item.id === 'salve' ? state.pack.salve < 3 : state.pack.equipment.length < 5));
    return useful ? { type: 'buy', itemId: useful.id } : { type: 'leave-shop' };
  }
  if (phase === 'map') {
    const ranked = ['house', 'camp', 'memorial', 'trainer', 'sable', 'wood-witch'];
    const options = snapshot.availableNodes;
    const chosen = options.slice().sort((a, b) => {
      const rank = option => {
        if (ranked.includes(option.id)) return ranked.indexOf(option.id) - 100;
        if (option.id.endsWith('-camp')) return -80;
        return option.risk === 'high' ? 10 : 0;
      };
      return rank(a) - rank(b);
    })[0];
    return { type: 'enter', node: chosen.id };
  }
  if (phase === 'event') {
    if (node === 'trainer') return { type: 'trainer', choice: 'rest' };
    const offer = storyOffer(state);
    if (offer?.eligible) return { type: 'event', choice: offer.id };
    const choices = storyChoices(state).map(([choice]) => choice);
    const choice = choices.includes('rest') ? 'rest' :
      choices.includes('letter') ? 'letter' : choices.includes('leave') ? 'leave' : choices[0];
    return { type: 'event', choice };
  }
  throw new Error('Unsupported phase ' + phase);
}

export function chooseJourneyIntent(snapshot, { passive = false, preferredNode } = {}) {
  if (preferredNode && snapshot.state.phase === 'map' &&
      snapshot.availableNodes.some(option => option.id === preferredNode)) {
    return { type: 'enter', node: preferredNode };
  }
  return snapshot.state.phase === 'battle' ? combatChoice(snapshot.state, passive) : fieldChoice(snapshot);
}

export function simulateJourney({ seed = 'five-region-1', passiveAfterRegion = null, maxActions = 2500 } = {}) {
  const fixtureSecret = createHash('sha256').update(seed).digest();
  const runs = openRuns(':memory:', { entropy: size => {
    if (size !== 32) throw new Error('Unexpected entropy size');
    return fixtureSecret;
  } });
  const accountId = 'fixture-player';
  let snapshot = runs.start(accountId);
  const encounters = [];
  try {
    for (let count = 0; !['WON', 'LOST'].includes(snapshot.lifecycle) && count < maxActions; count++) {
      const state = snapshot.state;
      const passive = passiveAfterRegion !== null && snapshot.checkpoints.length >= passiveAfterRegion;
      const intent = chooseJourneyIntent(snapshot, { passive });
      const previous = snapshot;
      snapshot = runs.act(accountId, snapshot.runId, {
        operationId: 'fixture-' + count, expectedVersion: snapshot.version, intent,
      });
      if (previous.state.phase === 'battle' && snapshot.state.phase !== 'battle') {
        encounters.push({ node: state.node, round: state.battle.round, outcome: snapshot.state.phase });
      }
    }
    const replay = runs.replay(accountId, snapshot.runId);
    const progress = runs.verifyProgress(accountId, snapshot.runId);
    const verified = ['WON', 'LOST'].includes(snapshot.lifecycle)
      ? runs.verifyCompleted(accountId, snapshot.runId) : null;
    return {
      kind: 'local-authoritative-gameplay-fixture', seed, fixtureSecretHex: fixtureSecret.toString('hex'),
      passiveAfterRegion, lifecycle: snapshot.lifecycle, runId: snapshot.runId, ruleset: snapshot.ruleset,
      actionCount: replay.events.length, encounters, checkpoints: snapshot.checkpoints,
      checkpointEvents: progress.observations.filter(event => event.kind === 'checkpoint'),
      acceptedIntentHash: createHash('sha256').update(JSON.stringify(replay.events.map(event => event.intent))).digest('hex'),
      summary: verified?.summary, stateHash: replay.stateHash, replayVerified: replay.verified,
      visited: snapshot.state.visited, finalParty: snapshot.state.heroes.map(hero => ({
        id: hero.id, hp: hero.hp, maxHp: hero.maxHp, level: hero.level,
      })), events: replay.events,
      finalCurseSources: snapshot.state.heroes.reduce((count, hero) => count + (hero.curseSources?.length ?? 0), 0),
      limits: 'Headless practice simulation with a fixed fixture seed. The bot forecasts from public snapshots using placeholder randomness. Run IDs are random, so compare acceptedIntentHash and checkpoints across runs. Browser play and on-chain settlement remain unverified by this fixture.',
    };
  } finally { runs.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(pathResolve(process.argv[1])).href) {
  const seed = process.argv.find(arg => arg.startsWith('--seed='))?.slice(7) ?? 'five-region-1';
  const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9);
  const passiveFlag = process.argv.find(arg => arg.startsWith('--passive-after-region='));
  const passiveAfterRegion = passiveFlag ? Number(passiveFlag.slice('--passive-after-region='.length)) : null;
  if (passiveAfterRegion !== null && (!Number.isInteger(passiveAfterRegion) || passiveAfterRegion < 0 || passiveAfterRegion >= regions.length)) {
    throw new Error('Expected --passive-after-region between 0 and 4');
  }
  const result = simulateJourney({ seed, passiveAfterRegion });
  if (output) {
    mkdirSync(pathResolve(output, '..'), { recursive: true });
    writeFileSync(output, JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify({ seed, lifecycle: result.lifecycle, actions: result.actionCount,
    encounters: result.encounters, checkpoints: result.checkpoints, replayVerified: result.replayVerified }, null, 2));
  if (result.lifecycle !== (passiveAfterRegion === null ? 'WON' : 'LOST') ||
    !result.replayVerified || (passiveAfterRegion === null && (result.finalCurseSources !== 0 ||
      JSON.stringify(result.checkpoints.map(checkpoint => checkpoint.node)) !== JSON.stringify(regions.map(region => region.boss)) ||
      result.checkpointEvents.length !== regions.length))) process.exitCode = 1;
}

