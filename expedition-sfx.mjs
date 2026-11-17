import { attackCues } from './expedition-sfx-catalog.mjs';

const interfaceCues = new Set([
  'ui-click', 'ui-back', 'ui-open', 'ui-tab', 'ui-confirm', 'ui-cancel', 'ui-choice',
  'target-lock', 'dice-select-party', 'dice-select-foe', 'dice-blocked',
  'dice-spin', 'dice-land', 'dice-reveal', 'dice-shatter', 'roll', 'rollFast', 'reroll',
  'route', 'loot', 'loot-copper', 'loot-equipment', 'loot-token', 'loot-engrave',
  'loot-remedy', 'loot-instant', 'shop-buy', 'training', 'quest',
  'spawn', 'foe-arrival', 'turn', 'hit', 'critical', 'break', 'dodge', 'miss',
  'heal', 'revive', 'buff', 'debuff', 'cleanse', 'curse', 'fall', 'win', 'defeat',
]);
const preloadCues = ['ui-click','ui-open','ui-tab','ui-confirm','ui-back',
  'dice-select-party','dice-select-foe','dice-shatter','target-lock','roll','dice-land','hit'];
const cached = new Map();

function sample(context, name) {
  if (!cached.has(name)) {
    const load = fetch('./combat-assets/sfx-v2/' + name + '.mp3')
      .then(response => {
        if (!response.ok) throw new Error('SFX unavailable');
        return response.arrayBuffer();
      }).then(bytes => context.decodeAudioData(bytes));
    cached.set(name, load);
    load.catch(() => cached.delete(name));
  }
  return cached.get(name);
}

export function preloadSfx(context) {
  for (const name of preloadCues) void sample(context, name).catch(() => {});
}

export function playSfx(context, name, volume, rate = 1) {
  if (!context || !interfaceCues.has(name) && !attackCues.has(name)) return false;
  if (volume <= 0) return true;
  const started = performance.now();
  void sample(context, name).then(buffer => {
    if (context.state !== 'running' || performance.now() - started > 350) return;
    const sound = context.createBufferSource();
    const gain = context.createGain();
    sound.buffer = buffer;
    sound.playbackRate.value = rate;
    gain.gain.value = volume;
    sound.connect(gain).connect(context.destination);
    sound.onended = () => { sound.disconnect(); gain.disconnect(); };
    sound.start();
  }).catch(() => {});
  return true;
}

export function attackCue(key, actor, side, companionId) {
  const specialized = key === 'summon' && companionId ? 'summon-' + companionId
    : key === 'guard' && side === 'party' ? 'party-guard'
    : actor ? actor + '-' + key : key;
  if (attackCues.has(specialized)) return specialized;
  return attackCues.has(key) || interfaceCues.has(key) ? key : undefined;
}
