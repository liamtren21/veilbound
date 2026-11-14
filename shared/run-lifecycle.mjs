export function lifecycleFor(state) {
  if (state.phase === 'complete') return 'WON';
  if (state.phase === 'defeat') return 'LOST';
  if (state.node === 'threshold' && state.phase === 'event') return 'PREPARING';
  if (state.phase === 'reward' || (state.phase === 'event' && /-entry$/.test(state.node))) return 'CHECKPOINT';
  return 'ACTIVE';
}

export const isTerminal = lifecycle => ['WON', 'LOST', 'SETTLING', 'CLOSED'].includes(lifecycle);

