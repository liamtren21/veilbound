const heroIds = ['rook', 'mara', 'elian'];
const choices = ['strike', 'guard', 'mend', 'salve'];
const planningMs = 20_000;
const graceMs = 30_000;

export function createCoop({ id, players, now, inventory = {}, rewardSlots = 0, bossHp = 64, ruleset = 'breach-coop-v1' }) {
  if (!id || players?.length !== 3 || new Set(players).size !== 3 ||
      players.some(player => typeof player !== 'string' || !player) || !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(rewardSlots) || rewardSlots < 0 || rewardSlots > 3 ||
      !Number.isSafeInteger(bossHp) || bossHp < 1) throw new Error('invalid_coop_room');
  return {
    id, ruleset, phase: 'planning', deadline: now + planningMs, round: 1, nonce: 0, bossHp, timeline: [],
    actors: players.map((accountId, index) => ({
      accountId, heroId: heroIds[index], hp: 20, online: true, contribution: 0, action: null,
      salves: Number.isSafeInteger(inventory[accountId]) && inventory[accountId] > 0 ? inventory[accountId] : 0,
      rewardReserved: index < rewardSlots,
    })),
  };
}

function finish(state, phase) {
  state.phase = phase;
  state.deadline = null;
  state.rewards = state.actors.filter(actor => phase === 'won' && actor.rewardReserved && actor.contribution >= 5)
    .map(actor => ({ accountId: actor.accountId, id: JSON.stringify([state.id, actor.accountId]) }));
  return state;
}

function resolveRound(state, now) {
  const living = state.actors.filter(actor => actor.hp > 0);
  const selected = living.map(actor => ({
    actor, type: actor.action ?? 'strike', bot: actor.action === null,
  }));
  const order = ['guard', 'salve', 'mend', 'strike'];
  selected.sort((left, right) => order.indexOf(left.type) - order.indexOf(right.type));
  for (const { actor, type, bot } of selected) {
    if (type === 'strike') {
      const damage = Math.min(state.bossHp, 4);
      state.bossHp -= damage;
      if (!bot) actor.contribution += damage;
    } else if (type === 'guard' && !bot && actor.hp > 0) actor.contribution += 2;
    else if (type === 'mend' || type === 'salve') {
      const target = type === 'salve' ? actor : living.reduce((lowest, member) => member.hp < lowest.hp ? member : lowest);
      const restored = Math.min(20 - target.hp, type === 'salve' ? 6 : 3);
      if (type === 'salve') actor.salves--;
      target.hp += restored;
      if (!bot && restored > 0) actor.contribution += 1;
    }
  }
  if (state.bossHp > 0) for (const { actor, type } of selected) actor.hp = Math.max(0, actor.hp - (type === 'guard' ? 1 : 3));
  state.timeline.push({ round: state.round, actions: selected.map(({ actor, type, bot }) => ({ heroId: actor.heroId, type, bot })) });
  for (const actor of state.actors) actor.action = null;
  state.nonce++;
  if (!state.bossHp) return finish(state, 'won');
  if (state.round === 8 || state.actors.every(actor => actor.hp === 0)) return finish(state, 'lost');
  state.round++;
  state.deadline = now + planningMs;
  return state;
}

export function tickCoop(previous, now) {
  if (previous.deadline === null || now < previous.deadline) return previous;
  const state = structuredClone(previous);
  return state.phase === 'paused' ? finish(state, 'abandoned') : resolveRound(state, now);
}

export function submitCoop(previous, accountId, action, now) {
  if (!previous.actors.some(actor => actor.accountId === accountId)) throw new Error('coop_participant_required');
  if (action?.nonce !== previous.nonce) throw new Error('stale_coop_action');
  if (previous.phase !== 'planning' || now >= previous.deadline) throw new Error('coop_planning_closed');
  const state = structuredClone(previous);
  const actor = state.actors.find(item => item.accountId === accountId);
  if (!actor.online || !actor.hp) throw new Error('coop_actor_unavailable');
  if (!choices.includes(action.type) || (action.type === 'salve' && !actor.salves)) throw new Error('invalid_coop_action');
  if (actor.action) {
    if (actor.action === action.type) return previous;
    throw new Error('coop_actor_locked');
  }
  actor.action = action.type;
  return state.actors.every(item => item.hp === 0 || item.action) ? resolveRound(state, now) : state;
}

export function setCoopPresence(previous, accountId, online, now) {
  if (!previous.actors.some(actor => actor.accountId === accountId)) throw new Error('coop_participant_required');
  const current = tickCoop(previous, now);
  if (current.deadline === null) return current;
  const state = structuredClone(current);
  state.actors.find(item => item.accountId === accountId).online = online;
  if (state.phase === 'planning' && state.actors.every(actor => !actor.online)) {
    state.phase = 'paused';
    state.planningRemaining = state.deadline - now;
    state.deadline = now + graceMs;
  } else if (state.phase === 'paused' && online) {
    state.phase = 'planning';
    state.deadline = now + state.planningRemaining;
    delete state.planningRemaining;
  }
  return state;
}

export function viewCoop(state, accountId) {
  if (!state.actors.some(actor => actor.accountId === accountId)) throw new Error('coop_participant_required');
  return {
    ...structuredClone(state),
    actors: state.actors.map(({ action, salves, ...actor }) => actor.accountId === accountId
      ? { ...actor, action, salves }
      : { ...actor, locked: action !== null }),
  };
}
