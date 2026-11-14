import { parseCopper } from './money.mjs';

export function applyRunCopperCheckpoint({ copper, phase }, boss = null) {
  if (!Number.isSafeInteger(copper) || copper < 0) throw new RangeError('Invalid run Copper balance');
  const atomic = amount => parseCopper(String(amount)).toString();
  if (phase === 'defeat') {
    return { remaining: 0, checkpoint: null, lostCopperAtomic: atomic(copper) };
  }
  if (!boss) return { remaining: copper, checkpoint: null, lostCopperAtomic: '0' };
  const banked = phase === 'complete' ? copper : Math.floor(copper / 2);
  return {
    remaining: copper - banked,
    checkpoint: { ...boss, copperAtomic: atomic(banked), settlement: 'run-only' },
    lostCopperAtomic: '0',
  };
}

