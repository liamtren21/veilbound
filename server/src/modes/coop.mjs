import { createCoop, setCoopPresence, submitCoop, tickCoop, viewCoop } from '../../../shared/coop-rules.mjs';

export function beginCoop(room, now) {
  room.state = createCoop({ id: room.id, players: room.players, now, rewardSlots: room.players.length });
}

export function advanceCoop(room, accountId, operation, body, now) {
  if (!room.state.actors.some(actor => actor.accountId === accountId)) throw new Error('coop_participant_required');
  const current = room.state = tickCoop(room.state, now);
  room.state = operation === 'act' ? submitCoop(current, accountId, body, now)
    : operation === 'presence' ? setCoopPresence(current, accountId, body.online, now) : current;
  return viewCoop(room.state, accountId);
}


