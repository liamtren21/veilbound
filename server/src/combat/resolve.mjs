import { createHmac } from 'node:crypto';
import * as rules from '../../../expedition-rules.mjs';
import { story, training } from '../../../expedition-data.mjs';

export const COMBAT_VERSION = 'expedition-hmac-action-v1';

const handlers = {
  event: [['choice'], ['heroKey', 'curseId'], (state, i) => {
    const choice = i.choice;
    return rules.chooseEvent(state, choice, i.heroKey, i.curseId);
  }],
  enter: [['node'], [], (state, i, graph) => {
    const node = graph.nodes[state.node];
    if (!node?.next.includes(i.node)) return false;
    return rules.enter(state, i.node, { enemies: graph.nodes[i.node].enemies, availableNodes: node.next });
  }],
  configure: [['heroKey', 'slot', 'skill'], [], (state, i) => rules.configure(state, i.heroKey, i.slot, i.skill)],
  trainer: [['choice'], ['heroKey'], (state, i) => (Object.hasOwn(training, i.choice) || ['rest', 'leave'].includes(i.choice)) && rules.visitTrainer(state, i.choice, i.heroKey)],
  buy: [['itemId'], [], (state, i) => rules.buy(state, i.itemId)],
  'leave-shop': [[], [], state => rules.leaveShop(state)],
  salve: [['heroKey'], [], (state, i) => rules.fieldSalve(state, i.heroKey)],
  'use-remedy': [['itemId', 'heroKey'], ['curseId', 'slot', 'confirmed'], (state, i) =>
    rules.useRemedy(state, i.itemId, i.heroKey, options(i)).ok],
  'witch-service': [['itemId', 'heroKey'], ['curseId', 'slot', 'confirmed'], (state, i) =>
    rules.useWitchService(state, i.itemId, i.heroKey, options(i)).ok],
  'move-equipment': [['heroKey', 'slot'], ['index', 'confirmed'], (state, i) =>
    rules.moveEquipment(state, i.heroKey, i.slot, i.index ?? null, { confirmed: i.confirmed })],
  'discard-equipment': [['index'], [], (state, i) => rules.discardEquipment(state, i.index)],
  'use-die': [['dieId', 'round'], ['targetKey', 'itemId', 'brace'], (state, i) => {
    if (state.phase !== 'battle' || i.round !== state.battle.round) return false;
    const actor = rules.active(state.heroes)[0]?.key;
    if (i.brace && i.dieId === 'reserve') return false;
    const override = i.dieId === 'reserve' ? { actor, action: i.itemId } : i.brace ? 'brace' : undefined;
    if (i.itemId && !['salve', 'guard-token', 'purify-token', 'heal-all', 'full-heal-all'].includes(i.itemId)) return false;
    if (i.itemId && i.dieId !== 'reserve') return false;
    const plan = rules.describe(state, i.dieId, override);
    if (!plan || plan.reason || (plan.enemy && plan.die.optional)) return false;
    if (i.targetKey && !plan.targets.some(target => target.key === i.targetKey)) return false;
    const target = i.targetKey ?? (plan.targets.length === 1 ? plan.targets[0].key : undefined);
    return rules.resolve(state, i.dieId, target, override);
  }],
  'end-round': [['round'], [], (state, i) => i.round === state.battle?.round && rules.endRound(state)],
  reroll: [['round'], [], (state, i) => i.round === state.battle?.round && rules.rerollDice(state).length > 0],
  claim: [['choice'], ['heroKey', 'skill'], (state, i) => rules.claim(state, i.choice, i.heroKey, i.skill)],
  'tutorial-loot': [['itemId'], [], (state, i) => rules.tutorialLoot(state, i.itemId)],
};

function options({ curseId, slot, confirmed }) {
  return { curseId, slot, confirmed };
}

export function validateIntent(intent) {
  if (!intent || Object.getPrototypeOf(intent) !== Object.prototype || !Object.hasOwn(handlers, intent.type)) return false;
  const [required, optional] = handlers[intent.type];
  if (required.some(key => !Object.hasOwn(intent, key))) return false;
  return Object.entries(intent).every(([key, value]) => {
    if (key === 'type') return true;
    if (!required.includes(key) && !optional.includes(key)) return false;
    if (key === 'index' && value === null) return true;
    if (['index', 'slot', 'round'].includes(key)) return Number.isSafeInteger(value) && value >= 0;
    if (['confirmed', 'brace'].includes(key)) return typeof value === 'boolean';
    return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
  });
}

export function seededValue(secret, sequence, stream) {
  return createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(COMBAT_VERSION + ':' + sequence + ':' + stream).digest().readUInt32LE(0) || 1;
}

export function applyCombatIntent(state, intent, { secret, sequence, graph }) {
  if (!validateIntent(intent)) return false;
  if (intent.type === 'event' && !Object.hasOwn(story, state.node)) return false;
  state.seed = seededValue(secret, sequence, 'encounter');
  state.economySeed = seededValue(secret, sequence, 'economy') | 0;
  if (state.battle) {
    for (const stream of ['dice', 'effects', 'curse']) {
      state.battle.rng[stream] = seededValue(secret, sequence, stream) | 0;
    }
  }
  const outcome = handlers[intent.type][2](state, intent, graph);
  return outcome === true ? { type: intent.type } : outcome || false;
}

