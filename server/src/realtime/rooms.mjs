import { randomUUID } from 'node:crypto';
import { advanceDuel, beginDuel, practiceBot } from '../modes/pvp.mjs';
import { advanceCoop, beginCoop } from '../modes/coop.mjs';
import { matchRanked, rankedQueueLifetime } from '../modes/matchmaking.mjs';
import { freshSeason } from '../modes/rating.mjs';

const limits = { duel: 2, coop: 3 };
const regionPattern = /^[a-z0-9-]{1,16}$/;

export const freshRooms = () => ({ rooms: {}, queue: [], season: freshSeason() });

export function roomsAction(data, { mode, roomId, operation, accountId, body, now, rankedEnabled }) {
  const start = mode === 'duel' ? beginDuel : beginCoop;
  if (!roomId && operation === 'create') {
    const id = randomUUID();
    return data.rooms[id] = { id, mode, players: [accountId], ready: [] };
  }
  if (mode === 'duel' && roomId === 'practice' && operation === 'practice') {
    if (accountId === practiceBot) throw new Error('duel_participant_required');
    const id = randomUUID();
    const room = { id, mode, practice: true, players: [accountId, practiceBot] };
    beginDuel(room, now);
    data.rooms[id] = room;
    return advanceDuel(room, accountId, 'read', {}, now, data.season);
  }
  if (mode === 'duel' && roomId === 'ranked') {
    if (!rankedEnabled) throw new Error('ranked_unavailable');
    const matches = Object.values(data.rooms).filter(room => room.ranked && room.players.includes(accountId));
    const active = matches.find(room => room.state.phase !== 'finished');
    const rating = () => data.season.ratings[accountId] ?? 1000;
    if (active) {
      advanceDuel(active, accountId, 'read', {}, now, data.season);
      if (active.state.phase !== 'finished') return { id: active.id, rating: rating() };
    }
    data.queue = data.queue.filter(entry => now < entry.joinedAt + rankedQueueLifetime);
    if (operation === 'leave') {
      data.queue = data.queue.filter(entry => entry.accountId !== accountId);
      return { queued: false, rating: rating() };
    }
    if (operation === 'read') {
      const entry = data.queue.find(entry => entry.accountId === accountId);
      if (entry) return { queued: true, region: entry.region, expiresAt: entry.joinedAt + rankedQueueLifetime, rating: rating() };
      const latest = matches.at(-1);
      return { queued: false, rating: rating(), lastMatchId: latest?.id ?? null };
    }
    if (operation !== 'join' || typeof body.region !== 'string' || !regionPattern.test(body.region)) {
      throw new Error('invalid_queue_request');
    }
    const result = matchRanked(data.queue, data.season.ratings, accountId, body.region, now);
    data.queue = result.queue;
    if (!result.opponent) {
      const entry = data.queue.find(entry => entry.accountId === accountId);
      return { queued: true, region: entry.region, expiresAt: entry.joinedAt + rankedQueueLifetime, rating: rating() };
    }
    const id = randomUUID();
    const room = { id, mode, ranked: true, players: [result.opponent, accountId] };
    start(room, now);
    data.rooms[id] = room;
    return { id, rating: rating() };
  }
  const room = Object.hasOwn(data.rooms, roomId) && data.rooms[roomId];
  if (!room || room.mode !== mode) throw new Error('room_missing');
  if (operation === 'join') {
    if (room.players.includes(accountId)) return { id: room.id, players: room.players };
    if (room.state || room.players.length >= limits[mode]) throw new Error('room_full');
    room.players.push(accountId);
    return room;
  }
  if (!room.players.includes(accountId)) throw new Error('room_participant_required');
  if (operation === 'ready' && !room.state) {
    if (!room.ready.includes(accountId)) room.ready.push(accountId);
    if (room.ready.length === limits[mode]) start(room, now);
    else return room;
  }
  if (!room.state) {
    if (operation !== 'read') throw new Error('room_not_started');
    return room;
  }
  if (operation === 'presence' && typeof body.online !== 'boolean') throw new Error('invalid_presence');
  return mode === 'duel' ? advanceDuel(room, accountId, operation, body, now, data.season)
    : advanceCoop(room, accountId, operation, body, now);
}

