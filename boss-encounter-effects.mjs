const START = -.19;
const END = .61;
const TIMES = [START, -.12, -.06, 0, .065, .14, .24, .38];
const LIFT = [14, 10, 7, 3, 0, 0, 2, 4];

export function drawEncounterEffect(ctx, effects, { sequence, targets, origin, age, reduced, mitigated, color }) {
  const effect = effects[sequence];
  if (!effect || !targets.length || age < START || age >= END) return null;
  const { frames } = effect;
  const frame = TIMES.findLastIndex(time => age >= time);
  const rect = frames[frame];
  const wide = targets.length === 4 && !mitigated;
  const sockets = wide ? [[(targets[0][0] + targets.at(-1)[0]) / 2, Math.max(...targets.map(([, y]) => y)) + 20]] : targets;
  const referenceWidth = Math.max(...frames.map(rect => rect[2]));
  const referenceHeight = Math.max(...frames.map(rect => rect[3]));
  const scale = Math.min((wide ? 565 : 182) / referenceWidth, (wide ? 258 : 188) / referenceHeight) *
    (mitigated ? .7 : 1);
  const width = rect[2] * scale;
  const height = rect[3] * scale;
  const fade = frame >= 6 ? 1 - (age - TIMES[6]) / (END - TIMES[6]) : 1;
  const onset = Math.min(1, (age - START) / .075);
  const travel = sequence === 0 && age < 0 && !reduced ? .43 * (age / START) ** 2 : 0;
  ctx.save();
  ctx.globalAlpha = onset * fade;
  if (!reduced) {
    ctx.shadowColor = color;
    ctx.shadowBlur = 4 + 10 * Math.exp(-((age-.026) ** 2) / .012);
  }
  for (const [targetX, targetY] of sockets) {
    const x = targetX + (origin[0] - targetX) * travel;
    const y = targetY + (origin[1] - targetY) * travel;
    ctx.drawImage(effect.image, ...rect, x - width / 2, y - height - LIFT[frame] + 12, width, height);
  }
  ctx.restore();
  return { sequence, frame, wide, count: sockets.length };
}
