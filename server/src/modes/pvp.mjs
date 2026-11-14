import { randomInt } from 'node:crypto';
import { actInDuel, createVeilDuel, resumeDuel, tickDuel, verifyDuelReplay } from '../../../shared/pvp-rules.mjs';
import { settleRating } from './rating.mjs';

export const practiceBot = 'practice-bot';

function playBot(state, now) {
  while (state.phase === 'active' && state.players[state.turn].id === practiceBot) {
    const player = state.players[state.turn];
    const opponent = state.players[1 - state.turn];
    const die = player.dice[0];
    const mostHurt = player.heroes.filter(hero => hero.hp > 0).sort((left, right) => left.hp - right.hp)[0];
    const target = die.face === 'strike'
      ? opponent.heroes.filter(hero => hero.hp > 0).sort((left, right) => left.hp - right.hp)[0].id
      : mostHurt.id;
    const type = die.face === 'summon' && (player.pet || player.summons >= 3) ? 'pass' : die.face;
    state = actInDuel(state, practiceBot, { nonce: state.nonce, die: die.id, type, target }, now);
  }
  return state;
}

export function advanceDuel(room, accountId, operation, body, now, season) {
  if (room.practice && accountId === practiceBot || !room.state.players.some(player => player.id === accountId)) throw new Error('duel_participant_required');
  const current = room.state = tickDuel(room.state, now);
  room.state = operation === 'resume' ? resumeDuel(current, accountId, now)
    : operation === 'act' ? actInDuel(current, accountId, body, now) : current;
  if (room.practice) room.state = playBot(room.state, now);
  if (room.state.phase === 'finished') verifyDuelReplay(room.state);
  settleRating(season, room.state);
  const { seed, ...view } = room.state;
  if (room.ranked && room.state.phase === 'finished') {
    const { delta, repeatedPair, forfeit } = season.receipts[room.id];
    const firstPlayer = room.state.players[0].id === accountId;
    view.rating = { current: season.ratings[accountId], delta: delta ? (firstPlayer ? delta : -delta) : 0, repeatedPair, forfeit };
  }
  if (room.practice) {
    view.practice = true;
    view.players = view.players.map(player => ({ ...player, bot: player.id === practiceBot }));
  }
  return room.state.phase === 'finished' ? { ...view, seed } : view;
}

export function beginDuel(room, now) {
  room.state = createVeilDuel({ id: room.id, players: room.players, now, seed: room.practice ? 2 * randomInt(2 ** 31) : randomInt(2 ** 32), ranked: room.ranked });
}



