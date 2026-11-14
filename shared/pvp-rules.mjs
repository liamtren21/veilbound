const heroes = ['rook', 'mara', 'elian'];
const hp = 20;
const actionMs = 20_000;
const faces = ['strike', 'guard', 'mend', 'strike', 'strike', 'summon'];

function roll(player, round, seed) {
  player.dice = player.heroes.filter(hero => hero.hp > 0).map((hero, index) => {
    const rollKey = Math.imul(seed + 1, 0x9e3779b1) ^ Math.imul(round * 6 + index * 2 + player.seat, 0x85ebca77);
    const mixed = Math.imul(rollKey ^ (rollKey >>> 16), 0xc2b2ae35);
    return { id: hero.id, face: faces[(mixed >>> 0) % faces.length] };
  });
  for (const hero of player.heroes) hero.guard = 0;
  if (player.pet?.untilRound <= round) player.pet = null;
}

function beginRound(state, now) {
  state.turn = (state.initiative + state.round - 1) % 2;
  state.deadline = now + actionMs;
  for (const player of state.players) roll(player, state.round, state.seed);
}

export function createVeilDuel({ id, players, seed, now, ruleset = 'veil-duel-v1', ranked = false }) {
  if (!id || players?.length !== 2 || new Set(players).size !== 2 ||
      players.some(player => typeof player !== 'string' || !player) ||
      !Number.isSafeInteger(seed) || !Number.isSafeInteger(now)) throw new Error('invalid_duel');
  const state = {
    id, seed, ruleset, ranked, startedAt: now, phase: 'active', round: 1, nonce: 0, initiative: (seed >>> 0) % 2,
    players: players.map((id, seat) => ({
      id, seat, heroes: heroes.map(id => ({ id, hp, guard: 0 })), pet: null, summons: 0, timeouts: 0,
    })),
    timeline: [],
  };
  beginRound(state, now);
  return state;
}

function finish(state, winner, reason) {
  state.phase = 'finished';
  state.winner = winner?.id ?? null;
  state.reason = reason;
  state.deadline = null;
}

function advance(state, now) {
  const next = 1 - state.turn;
  if (state.players[next].dice.length) state.turn = next;
  else if (!state.players[state.turn].dice.length) {
    if (state.round === 12) {
      const [a, b] = state.players;
      const living = side => side.heroes.filter(hero => hero.hp > 0).length;
      const total = side => side.heroes.reduce((sum, hero) => sum + hero.hp, 0);
      const order = living(a) - living(b) || total(a) - total(b);
      return finish(state, order > 0 ? a : order < 0 ? b : null, 'round_limit');
    }
    state.round++;
    beginRound(state, now);
  }
  state.deadline = now + actionMs;
}

function removeDefeatedDice(side) {
  side.dice = side.dice.filter(die => side.heroes.some(hero => hero.id === die.id && hero.hp > 0));
  if (side.pet && !side.heroes.some(hero => hero.id === side.pet.hero && hero.hp > 0)) side.pet = null;
}

export function actInDuel(previous, accountId, action, now) {
  if (previous.phase !== 'active') throw new Error('duel_finished');
  if (action?.nonce !== previous.nonce) throw new Error('stale_duel_action');
  if (now >= previous.deadline) throw new Error('duel_deadline');
  if (previous.players[previous.turn].id !== accountId) throw new Error('duel_turn_owner');
  const state = structuredClone(previous);
  const player = state.players[state.turn];
  const opponent = state.players[1 - state.turn];
  const die = action.type === 'pass' ? player.dice[0] : player.dice.find(die => die.id === action.die);
  if (!die || (action.type !== 'pass' && die.face !== action.type)) throw new Error('invalid_duel_die');
  const targetSide = action.type === 'strike' ? opponent : player;
  const target = targetSide.heroes.find(hero => hero.id === action.target && hero.hp > 0);
  if (['strike', 'mend', 'guard'].includes(action.type) && !target) throw new Error('invalid_duel_target');
  if (action.type === 'summon') {
    if (player.summons >= 3 || player.pet) throw new Error('duel_pet_unavailable');
    player.summons++;
    player.pet = { hero: die.id, untilRound: state.round + 3 };
  }
  if (action.type === 'strike') {
    const power = 5 + (player.pet?.hero === die.id ? 1 : 0);
    target.hp = Math.max(0, target.hp - Math.max(0, power - target.guard));
    target.guard = Math.max(0, target.guard - power);
    removeDefeatedDice(opponent);
  }
  if (action.type === 'guard') target.guard = Math.min(6, target.guard + 3);
  if (action.type === 'mend') target.hp = Math.min(hp, target.hp + (state.round < 9 ? 4 : 2));
  player.dice = player.dice.filter(item => item.id !== die.id);
  player.timeouts = 0;
  state.timeline.push({ nonce: state.nonce++, round: state.round, accountId, at: now, type: action.type, die: die.id, target: target?.id });
  if (opponent.heroes.every(hero => hero.hp === 0)) finish(state, player, 'knockout');
  else advance(state, now);
  return state;
}

export function tickDuel(previous, now) {
  if (previous.phase === 'finished' || now < previous.deadline) return previous;
  const state = structuredClone(previous);
  const player = state.players[state.turn];
  if (state.phase === 'forfeit_grace') {
    state.timeline.push({ at: now, type: 'forfeit' });
    finish(state, state.players[1 - state.turn], 'timeout_forfeit');
    return state;
  }
  player.timeouts++;
  state.timeline.push({ nonce: state.nonce++, round: state.round, accountId: player.id, at: now, type: 'timeout' });
  if (player.timeouts === 2) {
    state.phase = 'forfeit_grace';
    state.deadline = now + 5_000;
  } else {
    player.dice.shift();
    advance(state, now);
  }
  return state;
}

export function resumeDuel(previous, accountId, now) {
  if (!previous.players.some(player => player.id === accountId)) throw new Error('duel_participant_required');
  const current = tickDuel(previous, now);
  if (current.phase !== 'forfeit_grace' || current.players[current.turn].id !== accountId) return current;
  const state = structuredClone(current);
  const player = state.players[state.turn];
  player.timeouts = 0;
  state.timeline.push({ accountId, at: now, type: 'resume' });
  state.phase = 'active';
  state.deadline = now + actionMs;
  return state;
}

export function verifyDuelReplay(match) {
  const { id, seed, ruleset, ranked, startedAt, timeline } = match;
  let replayed = createVeilDuel({ id, seed, ruleset, ranked, now: startedAt, players: match.players.map(player => player.id) });
  for (const event of timeline) {
    replayed = event.type === 'timeout' || event.type === 'forfeit' ? tickDuel(replayed, event.at)
      : event.type === 'resume' ? resumeDuel(replayed, event.accountId, event.at)
      : actInDuel(replayed, event.accountId, event, event.at);
  }
  if (JSON.stringify(replayed) !== JSON.stringify(match)) throw new Error('duel_replay_mismatch');
  return true;
}
