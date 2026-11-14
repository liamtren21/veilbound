import { active, canEndRound, canEngrave, describe, rerollableDice, shopInventory } from './expedition-rules.mjs';
import { actions, equipment, instantItems, foes, heroes, nodes, regionOf, story, tokens, training } from './expedition-data.mjs';
import { asset, wardenPreview } from './expedition-art.mjs';
import { dicePainting, paintDiceFace } from './expedition-dice-paint.mjs';
import { beats } from './expedition-motion-library.mjs';
import { cue, settings } from './expedition-options.mjs';
import { companionForHero } from './expedition-companions.mjs';


const names = { trials: 'Accord Trials', weekly: 'Weekly Oath', raid: 'The Breach', duel: 'Veil Duel', coop: 'Co-op Breach', rewards: 'Rewards' };
const modePresentation = {
  trials: ['talismans-v3/gate.png', 'Choose a Talisman and face an Accord challenge.'],
  weekly: ['talismans-v3/river.png', 'Take on the weekly route with a fixed roster.'],
  raid: ['region-emblems-v2/fire.png', 'Break the Kiln’s ward and contribute damage to the shared raid.', 'kiln-that-hungers'],
  duel: ['region-emblems-v2/metal.png', 'Face another Warden squad in a dice duel.'],
  coop: ['region-emblems-v2/water.png', 'Bring three Wardens together against the Bell-Drowned.', 'bell-drowned'],
  rewards: ['account-v1/copper.png', 'Review rewards earned from Game Modes.'],
};
const errors = {
  WEEKLY_AUTHORITY_UNAVAILABLE: 'Weekly Oath is unavailable on this server.',
  RAID_AUTHORITY_UNAVAILABLE: 'The Breach is unavailable on this server.',
  MODE_ADAPTER_UNAVAILABLE: 'Weekly combat is unavailable on this server.',
  WEEKLY_CLOSED: 'Weekly Oath is closed.', RAID_CLOSED: 'The Breach is closed.',
  WEEKLY_MILESTONE_UNEARNED: 'Complete the Weekly Oath milestone to claim its reward.',
  RUN_NOT_COMPLETE: 'Finish the run before submitting it.',
  RUN_NOT_FOUND: 'This run is unavailable in your session.',
  SESSION_REQUIRED: 'Your session has expired. Reload this page to reconnect.',
  STALE_VERSION: 'The run has changed. Resume it to refresh the encounter.',
  ROOM_PARTICIPANT_REQUIRED: 'Join the room before opening it.',
  RANKED_UNAVAILABLE: 'Ranked Veil Duel is unavailable on this server.',
};
const heading = document.querySelector('#mode-title');
const preview = document.querySelector('#mode-preview');
const notice = document.querySelector('#notice');
const panel = document.querySelector('#panel');
const encounter = document.querySelector('#encounter');
const nav = [...document.querySelectorAll('nav a')];
const session = request('/api/session').then(value => ({ value }), error => ({ error }));
const roomLimits = { duel: 2, coop: 3 };
let account;
let page;
let busy = false;
let socket;
let refreshTimer;
let rankedTimer;
let activeRoom;
let room;

function el(tag, copy, parent) {
  const node = document.createElement(tag);
  if (copy != null) node.textContent = copy;
  parent?.append(node);
  return node;
}
function group(parent) {
  const node = el('div', null, parent);
  node.className = 'actions';
  return node;
}
function feedback(copy = '', error = false) {
  notice.textContent = copy;
  notice.toggleAttribute('data-error', error);
}
async function request(path, body) {
  const response = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) {
    throw new Error(value?.error ?? 'Connection failed');
  }
  return value;
}
const mode = (path, body) => request('/api/modes/' + path, body);
const label = value => String(value).replace(/[-_]/g, ' ').replace(/^./, letter => letter.toUpperCase());
function list(parent, items, tag = 'ul') {
  const node = el(tag, null, parent);
  for (const item of items) el('li', item, node);
  return node;
}
async function task(origin, operation, target) {
  if (busy || page !== origin) return;
  busy = true;
  target.disabled = true;
  feedback();
  try {
    await operation();
  } catch (error) {
    if (page === origin) feedback(errors[error.message] ?? label(error.message), true);
  } finally {
    busy = false;
    target.disabled = false;
  }
}
function button(parent, title, handler) {
  const origin = page;
  const node = el('button', title, parent);
  node.type = 'button';
  node.addEventListener('click', () => task(origin, handler, node));
  return node;
}
function choose(form, title, entries) {
  const field = el('label', title, form);
  const select = el('select', null, field);
  for (const [value, name] of entries) {
    const option = el('option', name, select);
    option.value = value;
  }
  return select;
}
function submit(form, title, handler) {
  const origin = page;
  const node = el('button', title, form);
  form.addEventListener('submit', event => {
    event.preventDefault();
    void task(origin, handler, node);
  });
}
function idForm(parent, title, placeholder, handler) {
  const form = el('form', null, parent);
  const field = el('label', title, form);
  const input = el('input', null, field);
  input.required = true;
  input.maxLength = 100;
  input.pattern = '[A-Za-z0-9_\\-]{1,100}';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.value = placeholder ?? '';
  submit(form, title.startsWith('Room') ? 'Join room' : 'Open run', () => handler(input.value));
}
function stash(key, value) {
  const storageKey = 'veilbound-modes:' + account + ':' + key;
  try {
    if (value !== undefined) localStorage.setItem(storageKey, value);
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}
function operationId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('');
}
function openRunControls(kind, target = panel) {
  const id = stash(kind);
  if (id) button(target, 'Resume', () => loadRun(kind, id));
}
async function loadRun(kind, id) {
  const origin = page;
  const run = await request('/api/runs/' + id);
  if (!(kind === 'trials' ? ['trial', 'practice', 'expedition'] : ['weekly']).includes(run.mode)) {
    throw new Error('This run belongs to another mode');
  }
  if (page !== origin) return;
  stash(kind, run.runId);
  renderRun(kind, run);
}
const actionArt = {
  wardbreak: 'stone-answer', mark: 'witness-seal', protect: 'guard',
  counter: 'strike', burst: 'stone-answer', mend: 'salve',
};

function beginEncounter() {
  encounter.replaceChildren();
  document.body.removeAttribute('data-playing');
  document.body.removeAttribute('data-waiting');
}

function battlefield(title, round, art, allies, opponents, status = '') {
  document.body.setAttribute('data-playing', '');
  const stage = el('div', null, encounter);
  stage.className = 'mode-battlefield';
  stage.style.setProperty('--arena-art', 'url("' + asset(art) + '")');
  const header = el('header', null, stage);
  const back = button(header, 'Back to modes', () => showPage(true));
  back.className = 'mode-battle-back';
  const heading = el('div', null, header);
  el('h3', title, heading);
  el('p', 'Round ' + round + (status ? ' · ' + status : ''), heading);
  const field = el('div', null, stage);
  field.className = 'mode-formations';
  const targets = [];
  for (const [side, units] of [['party', allies], ['foe', opponents]]) {
    const formation = el('div', null, field);
    formation.className = 'mode-formation ' + side;
    formation.dataset.count = units.length;
    for (const unit of units) {
      const figure = el('figure', null, formation);
      if (!unit.hp) figure.dataset.fallen = '';
      const boss = foes[unit.id]?.behavior === 'boss';
      if (boss) figure.dataset.boss = '';
      const target = el('button', null, figure);
      target.type = 'button';
      target.className = 'mode-target';
      target.setAttribute('aria-label', 'Target ' + unit.name);
      target.tabIndex = -1;
      target.disabled = true;
      target.append(wardenPreview(unit.id, { animate: boss && Boolean(unit.hp) && !settings.motion, highResolution: boss }));
      if (unit.mirrored) target.dataset.mirrored = '';
      const caption = el('figcaption', null, figure);
      el('strong', unit.name, caption);
      const maxHp = Math.max(unit.maxHp ?? unit.hp, unit.hp, 1);
      const health = el('div', null, caption);
      health.className = 'mode-health';
      const meter = el('meter', null, health);
      meter.max = maxHp;
      meter.value = unit.hp;
      meter.setAttribute('aria-label', unit.name + ' health');
      const track = el('span', null, health);
      track.className = 'mode-health-segments';
      track.setAttribute('aria-hidden', 'true');
      for (let index = 0; index < 8; index++) {
        const fill = el('span', null, el('span', null, track));
        fill.style.width = Math.max(0, Math.min(1, unit.hp * 8 / maxHp - index)) * 100 + '%';
      }
      el('small', unit.hp + (unit.maxHp ? '/' + unit.maxHp : '') + ' HP' +
        (unit.detail ? ' · ' + unit.detail : ''), caption);
      targets.push({ target, unit });
    }
  }
  const hud = el('footer', null, stage);
  const hint = el('p', 'Choose an action', hud);
  hint.className = 'mode-action-hint';
  hint.setAttribute('role', 'status');
  const controls = group(hud);
  let selected;
  let targeting;
  function clearSelection() {
    selected?.setAttribute('aria-pressed', 'false');
    selected = null;
    targeting = null;
    hint.textContent = 'Choose an action';
    for (const { target } of targets) {
      target.disabled = true;
      target.tabIndex = -1;
    }
  }
  for (const { target, unit } of targets) {
    // The sprite button is also the keyboard target for a selected action.
    target.addEventListener('click', () => {
      if (targeting) void task(page, () => targeting(unit.key), target);
    });
  }
  stage.addEventListener('keydown', event => {
    if (event.key === 'Escape' && selected) {
      const previous = selected;
      clearSelection();
      previous.focus();
    }
  });
  function action(name, key, actor, side, perform, choices = [], reason = '') {
    const tile = button(controls, '', () => {
      if (!choices.length) return perform();
      const wasSelected = selected === tile;
      clearSelection();
      if (wasSelected) return;
      selected = tile;
      targeting = perform;
      tile.setAttribute('aria-pressed', 'true');
      hint.textContent = name + ' · Choose a target';
      for (const { target, unit } of targets) {
        target.disabled = !choices.includes(unit.key);
        target.tabIndex = target.disabled ? -1 : 0;
      }
    });
    tile.className = 'mode-action';
    tile.dataset.side = side;
    tile.disabled = Boolean(reason);
    tile.title = reason || name;
    if (choices.length) tile.setAttribute('aria-pressed', 'false');
    const icon = el('span', null, tile);
    icon.className = 'mode-action-icon';
    icon.setAttribute('aria-hidden', 'true');
    const artKey = actionArt[key] ?? key;
    const artActor = key === 'summon' ? companionForHero({ id: actor }) : actor;
    if (dicePainting(artActor, artKey, side)) paintDiceFace(icon, artActor, artKey, side);
    else paintDiceFace(icon, '', side === 'foe' ? 'rake' : 'strike', side);
    el('span', name, tile);
    return tile;
  }
  return { header, controls, hint, action };
}

function playModeRoll(view, tiles, reroll = false) {
  if (!tiles.length || settings.motion) return;
  const { controls, hint } = view;
  const previousHint = hint.textContent;
  controls.inert = true;
  controls.setAttribute('aria-busy', 'true');
  hint.textContent = reroll ? 'Rerolling unused dice…' : 'Rolling dice…';
  cue(reroll ? 'reroll' : 'roll', settings.speed);
  const animations = [];
  const spinning = [];
  tiles.forEach((tile, index) => {
    const face = tile.querySelector('.mode-action-icon');
    const cube = el('span', null, face);
    cube.className = 'mode-roll-cube';
    for (const key of ['strike', 'guard', 'rotate', 'salve', 'brace']) {
      const side = el('span', null, cube);
      paintDiceFace(side, '', key, 'party');
    }
    const result = el('span', null, cube);
    for (const mark of [...face.children]) {
      if (mark !== cube) result.append(mark.cloneNode(true));
    }
    face.dataset.rolling = '';
    spinning.push([face, cube]);
    const spin = (beats.rollSpinMin + 120) / settings.speed;
    const settle = beats.rollSettleMin / settings.speed;
    const duration = spin + settle;
    const delay = index * beats.rollStagger / settings.speed;
    const landing = spin / duration;
    animations.push(cube.animate([
      { transform: 'translateY(0) rotateX(-560deg) rotateY(-460deg)', offset: 0 },
      { transform: 'translateY(-22px) rotateX(-320deg) rotateY(-245deg)', offset: landing * .52 },
      { transform: 'translateY(0) rotateX(-40deg) rotateY(-25deg)', offset: landing, easing: beats.settleEase },
      { transform: 'translateY(0) rotateX(0deg) rotateY(0deg)', offset: 1 },
    ], { duration, delay, fill: 'both' }));
    animations.push(face.animate([
      { transform: 'scale(1)' }, { transform: 'scale(1.13)', offset: .22 }, { transform: 'scale(1)' },
    ], { duration: settle, delay: delay + spin }));
  });
  void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
    for (const animation of animations) animation.cancel();
    for (const [face, cube] of spinning) {
      cube.remove();
      delete face.dataset.rolling;
    }
    controls.inert = false;
    controls.removeAttribute('aria-busy');
    hint.textContent = previousHint;
  });
}

function wardenName(id) {
  return heroes.find(hero => hero.id === id)?.name ?? label(id);
}

function renderRun(kind, run, rerolledIds = []) {
  const origin = page;
  const { state, runId, lifecycle, availableNodes } = run;
  const node = nodes.find(node => node.id === state.node);
  beginEncounter();
  const battle = state.phase === 'battle' && !['WON', 'LOST'].includes(lifecycle);
  if (!battle) el('h3', node?.name ?? 'Expedition', encounter);
  if (!battle) el('p', (state.report || 'Choose your next action.') + ' · ' + state.copper + ' Copper', encounter);
  const go = async intent => {
    const rerolled = intent.type === 'reroll' ? rerollableDice(state).map(die => die.id) : [];
    const next = await request('/api/runs/' + runId + '/actions', {
      operationId: operationId(), expectedVersion: run.version, intent,
    });
    if (page === origin) renderRun(kind, next, rerolled);
  };
  const pick = (parent, name, type, fields = {}) => button(parent, name, () => go({ type, ...fields }));
  const team = state.heroes.filter(hero => !hero.bench);
  const living = team.filter(hero => hero.hp > 0);
  const hp = hero => hero.name + ' · ' + hero.hp + '/' + hero.maxHp + ' HP';
  if (['WON', 'LOST'].includes(lifecycle)) {
    el('p', lifecycle === 'WON' ? 'Run won' : 'Run lost', encounter);
    const clear = kind === 'trials' && run.mode !== 'trial';
    if (clear && lifecycle === 'LOST') return;
    button(encounter, clear ? 'Import clear' : 'Submit result', async () => {
      const result = await mode(kind + (clear ? '/import-clear' : '/settle'), { runId });
      if (page !== origin) return;
      if (kind === 'weekly') {
        await showWeekly();
        if (page !== origin) return;
        feedback((result.ranked ? 'Ranked result recorded' : 'Practice result recorded') + ' · ' + result.rounds + ' rounds');
      } else {
        await showTrials();
        if (page !== origin) return;
        feedback(clear ? 'Talisman clear recorded.' : 'Trial result recorded.');
      }
    });
    return;
  }
  const arena = el('div', null, encounter);
  arena.className = 'arena';
  const side = el('div', null, arena);
  el('h3', 'Wardens', side);
  list(side, team.map(hp));
  if (battle) {
    arena.remove();
    const { dice, round, enemies } = state.battle;
    const region = regionOf(node);
    const art = node?.type === 'boss' ? 'boss-arena-' + region.id + '-v1.png'
      : 'expedition-scenes-v2/battle-' + region.id + '.webp';
    const view = battlefield(node?.name ?? names[kind], round, art, team, enemies, names[kind]);
    el('p', state.copper + ' Copper', view.header).className = 'mode-battle-meta';
    const stamp = JSON.stringify([runId, state.node, state.visited.length, round]);
    const freshRound = origin.rollStamp !== stamp;
    origin.rollStamp = stamp;
    const rolling = [];
    for (const die of dice) {
      const plan = describe(state, die.id);
      if (!plan || plan.enemy && die.optional) continue;
      const choices = plan.targets.length > 1 && (!plan.enemy || plan.choose) && !plan.random
        ? plan.targets.map(unit => unit.key) : [];
      const tile = view.action(plan.name, plan.key ?? die.face, plan.actor.id, die.side,
        targetKey => go({ type: 'use-die', dieId: die.id, round, ...(targetKey ? { targetKey } : {}) }),
        choices, plan.reason);
      if (!die.spent && !die.fixed && (freshRound || rerolledIds.includes(die.id))) rolling.push(tile);
    }
    const leader = active(state.heroes)[0];
    for (const itemId of Object.keys(tokens)) {
      if (!leader || !state.pack[itemId]) continue;
      const plan = describe(state, 'reserve', { actor: leader.key, action: itemId });
      if (plan && !plan.reason) view.action(tokens[itemId].name, itemId, leader.id, 'party',
        targetKey => go({ type: 'use-die', dieId: 'reserve', round, itemId, targetKey }),
        plan.targets.map(unit => unit.key));
    }
    if (rerollableDice(state).length) pick(view.controls, 'Reroll', 'reroll', { round });
    pick(view.controls, 'End round', 'end-round', { round }).disabled = !canEndRound(state);
    playModeRoll(view, rolling, Boolean(rerolledIds.length));
    return;
  }
  const controls = group(encounter);
  if (state.phase === 'map') {
    for (const { id, risk } of availableNodes) pick(controls,
      (nodes.find(node => node.id === id)?.name ?? label(id)) + (risk ? ' · ' + label(risk) : ''), 'enter', { node: id });
  }
  if (state.phase === 'event' && state.node === 'trainer') {
    pick(controls, 'Rest', 'trainer', { choice: 'rest' });
    pick(controls, 'Leave', 'trainer', { choice: 'leave' });
    const form = el('form', null, encounter);
    const hero = choose(form, 'Warden', living.map(unit => [unit.key, unit.name]));
    const trainingOption = choose(form, 'Training', Object.entries(training).map(([id, value]) => [id, value.label]));
    submit(form, 'Train', () => go({ type: 'trainer', choice: trainingOption.value, heroKey: hero.value }));
  } else if (state.phase === 'event' && story[state.node]) {
    const event = story[state.node];
    el('p', event.copy, encounter);
    for (const [choice, name, hint] of event.choices) {
      if (choice === 'bargain') {
        const form = el('form', null, encounter);
        const hero = choose(form, 'Warden', living.map(unit => [unit.key, unit.name]));
        const curse = choose(form, 'Curse', ['withered', 'brittle', 'blood-debt'].map(id => [id, label(id)]));
        submit(form, name, () => go({ type: 'event', choice, heroKey: hero.value, curseId: curse.value }));
        continue;
      }
      const control = pick(controls, name, 'event', { choice });
      control.title = hint;
      control.disabled = choice === 'toll' && state.copper < 8 || choice === 'revive' && team.every(hero => hero.hp > 0);
    }
  }
  if (state.phase === 'shop') {
    for (const { id, name, price } of shopInventory(state)) pick(controls, name + ' · ' + price + ' Copper', 'buy', { itemId: id });
    pick(controls, 'Leave shop', 'leave-shop');
  }
  if (state.phase === 'reward') {
    const loot = state.battle.rewardOffer;
    if (loot?.copper) pick(controls, 'Take ' + loot.copper + ' Copper', 'claim', { choice: 'copper' });
    if (loot?.token) pick(controls, 'Take ' + tokens[loot.token].name, 'claim', { choice: 'token' });
    if (loot?.remedy) pick(controls, 'Take ' + label(loot.remedy), 'claim', { choice: 'remedy' });
    for (const item of loot?.gear ?? []) pick(controls, 'Take ' + equipment[item].name, 'claim', { choice: 'equipment', heroKey: item });
    if (loot?.instant) {
      const form = el('form', null, encounter);
      const target = choose(form, 'Warden', team.map(unit => [unit.key, unit.name]));
      submit(form, 'Use ' + instantItems[loot.instant].name, () => go({ type: 'claim', choice: 'instant', heroKey: target.value }));
    }
    if (node?.type === 'elite' && !state.battle.engravingClaimed) {
      const options = living.flatMap(hero => hero.skills.filter(skill => canEngrave(hero, skill))
        .map(skill => [hero.key + ':' + skill, hero.name + ' · ' + actions[skill].name]));
      if (options.length) {
        const form = el('form', null, encounter);
        const selection = choose(form, 'Skill', options);
        submit(form, 'Engrave', () => {
          const [heroKey, skill] = selection.value.split(':');
          return go({ type: 'claim', choice: 'engrave', heroKey, skill });
        });
      }
    }
    pick(controls, 'Continue', 'claim', { choice: 'leave' });
  }
  if (state.pack.salve && ['event', 'map', 'shop'].includes(state.phase)) {
    for (const hero of living.filter(unit => unit.hp < unit.maxHp)) pick(controls, 'Salve ' + hero.name, 'salve', { heroKey: hero.key });
  }
}

function lobbyCard(parent, title, mark) {
  const card = el('section', null, parent);
  card.className = 'mode-lobby-card';
  const header = el('div', null, card);
  header.className = 'mode-card-title';
  if (mark) {
    const image = el('img', null, header);
    image.src = asset(mark);
    image.alt = '';
  }
  el('h3', title, header);
  return card;
}

function openLobbyPanel() {
  panel.replaceChildren();
  panel.className = 'mode-lobby-grid';
  return panel;
}

async function showTrials() {
  const origin = page;
  const [state, history, latest] = await Promise.all([
    mode('trials'),
    request('/api/runs/expedition-history').catch(() => []),
    request('/api/runs/active').catch(() => null),
  ]);
  if (page !== origin) return;
  const lobby = openLobbyPanel();
  const challenge = lobbyCard(lobby, 'Select Trial', 'talismans-v3/gate.png');
  const preparation = lobbyCard(lobby, 'Qualification', 'account-v1/ledger.png');
  if (!state.clears.length) el('p', 'Clear an Expedition or qualifying practice to unlock your first Trial.', challenge);
  else if (!state.available.length) el('p', 'No Trials are currently available.', challenge);

  if (state.available.length) {
    const trialForm = el('div', null, challenge);
    const selected = choose(trialForm, 'Trial', state.available.map(trial => [
      trial.id, trial.name + (state.completed.includes(trial.id) ? ' · Cleared' : ''),
    ]));
    const options = el('div', null, challenge);
    const showTrial = () => {
      options.replaceChildren();
      const trial = state.available.find(entry => entry.id === selected.value);
      const entry = el('form', null, options);
      const talisman = choose(entry, 'Talisman', state.clears.map(id => [id, label(id)]));
      const support = trial.supportChoice ? choose(entry, 'Opening supply', [['salve', 'Salve'], ['bark-shield', 'Bark Shield']]) : null;
      submit(entry, 'Start trial', async () => {
        const result = await mode('trials/start', { trialId: trial.id, talisman: talisman.value, ...(support ? { support: support.value } : {}) });
        if (page !== origin) return;
        stash('trials', result.runId);
        renderRun('trials', result);
      });
    };
    selected.onchange = showTrial;
    showTrial();
  }
  button(group(preparation), 'Start qualifying practice', async () => {
    const result = await request('/api/runs', { mode: 'practice' });
    if (page !== origin) return;
    stash('trials', result.runId);
    renderRun('trials', result);
  });
  const completed = history.filter(run => run.outcome?.toLowerCase() === 'won');
  if (latest?.mode === 'practice' && latest.lifecycle === 'WON') {
    completed.unshift({ runId: latest.runId, talisman: latest.state.talisman });
  }
  const eligible = completed.filter(run => !state.clears.includes(run.talisman));
  if (eligible.length) {
    const form = el('form', null, preparation);
    const proof = choose(form, 'Completed run', eligible.map(run => [run.runId, label(run.talisman) + ' · Victory']));
    submit(form, 'Record clear', async () => {
      await mode('trials/import-clear', { runId: proof.value });
      if (page !== origin) return;
      await showTrials();
      if (page === origin) feedback('Talisman clear recorded.');
    });
  }
  openRunControls('trials', challenge);
}

async function showWeekly() {
  const origin = page;
  const board = await mode('weekly/board');
  if (page !== origin) return;
  const lobby = openLobbyPanel();
  const entry = lobbyCard(lobby, 'Enter the Oath', 'talismans-v3/river.png');
  el('p', 'Only ranked attempts appear on the board.', entry);
  const controls = group(entry);
  for (const practice of [false, true]) {
    button(controls, practice ? 'Start practice' : 'Start ranked attempt', async () => {
      const result = await mode('weekly/start', { practice, operationId: operationId() });
      if (page === origin) await loadRun('weekly', result.runId);
    });
  }
  openRunControls('weekly', entry);
  const ranks = lobbyCard(lobby, 'Leaderboard', 'account-v1/ledger.png');
  if (!board.length) el('p', 'No verified attempts yet.', ranks);
  else {
    const rows = el('ol', null, ranks);
    rows.className = 'mode-ranking';
    for (const row of board) {
      const item = el('li', null, rows);
      el('strong', row.accountId === account ? 'You' : row.accountId, item);
      el('span', (row.objective ? 'Cleared' : 'Incomplete') + ' · ' + row.rounds + ' rounds · ' + row.faints + ' faints', item);
    }
  }
  button(ranks, 'Claim milestone', async () => {
    const result = await mode('weekly/claim', {});
    if (page === origin) feedback('Claimed ' + label(result.reward) + '.');
  });
}

async function showBreach() {
  const origin = page;
  const status = await mode('raid/status');
  if (page !== origin) return;
  const lobby = openLobbyPanel();
  const objective = lobbyCard(lobby, 'The Kiln That Hungers', 'region-emblems-v2/fire.png');
  el('p', 'Shared boss health', objective);
  const health = el('progress', null, objective);
  health.max = status.totalHp;
  health.value = status.remainingHp;
  health.setAttribute('aria-label', 'Shared boss health');
  el('strong', status.remainingHp + ' / ' + status.totalHp + ' HP', objective);
  const copper = el('p', status.availableSlots + ' reward slots open', objective);
  copper.className = 'mode-reward-count';
  const entry = lobbyCard(lobby, 'Join the Raid', 'account-v1/ledger.png');
  const controls = group(entry);
  for (const practice of [false, true]) {
    button(controls, practice ? 'Start practice' : 'Enter the Breach', async () => {
      const result = await mode('raid/start', { practice, operationId: operationId() });
      if (page === origin) await openBreach(result.runId);
    }).disabled = !practice && !status.remainingHp;
  }
  const previous = stash('raid');
  if (previous) button(entry, 'Resume', () => openBreach(previous));
}

async function openBreach(id) {
  const origin = page;
  const state = await mode('raid/' + id + '/encounter');
  if (page !== origin) return;
  stash('raid', id);
  renderBreach(state);
}
function renderBreach(state) {
  const origin = page;
  const { runId, phase, round, version } = state;
  beginEncounter();
  const boss = { id: 'kiln-that-hungers', name: foes['kiln-that-hungers'].name,
    hp: state.bossHp, maxHp: ({sealed: 36, fractured: 40, exposed: 44})[state.variant],
    detail: state.ward + ' Ward' };
  const view = battlefield('The Breach', round, 'boss-arena-fire-v1.png',
    [{ id: 'rook', name: 'Warden party', hp: state.partyHp, maxHp: 26 }], [boss], 'Raid Boss · ' + label(state.variant));
  const controls = view.controls;
  if (state.objectives.length) el('p', 'Objectives · ' + state.objectives.map(label).join(', '), view.header).className = 'mode-battle-meta';
  for (const type of state.available) {
    view.action(type === 'wardbreak' ? 'Break ward' : label(type), type, 'rook', 'party', async () => {
      const result = await mode('raid/' + runId + '/act', { version, type });
      if (page === origin) renderBreach(result);
    });
  }
  if (phase !== 'active') {
    view.hint.textContent = phase === 'won' ? 'Encounter won' : 'Encounter lost';
    button(controls, 'Submit contribution', async () => {
      const result = await mode('raid/settle', { runId });
      if (page !== origin) return;
      await showBreach();
      if (page === origin) feedback(result.practice ? 'Practice score · ' + result.personalScore
        : 'Contribution recorded · ' + result.contribution + ' damage' + (result.entitlement ? ' · Reward earned' : ''));
    });
  }
}
function roomPath(kind, id) {
  return kind + '/' + id;
}
function clearRoom() {
  activeRoom = undefined;
  room = undefined;
  socket?.close();
  socket = undefined;
  clearTimeout(refreshTimer);
}
function showRankedEntry(initialRoom) {
  const origin = page;
  const section = lobbyCard(panel, 'Ranked Veil Duel', 'region-emblems-v2/metal.png');
  const summary = el('p', 'Checking ranked availability…', section);
  const controls = group(section);
  let queued = false;
  let live = true;

  function resumeMatch(id) {
    return mode(roomPath('duel', id)).then(state => {
      if (page === origin) {
        clearTimeout(rankedTimer);
        connectRoom('duel', state);
      }
    });
  }

  function renderRanked(state) {
    if (page !== origin || activeRoom || !live) return;
    clearTimeout(rankedTimer);
    controls.replaceChildren();
    summary.textContent = 'Rating ' + state.rating;
    if (state.id) {
      summary.textContent += ' · Match found';
      button(controls, 'Resume ranked match', () => resumeMatch(state.id));
      if (!initialRoom) void resumeMatch(state.id).catch(problem);
      return;
    }
    queued = state.queued;
    if (queued) {
      summary.textContent += ' · Waiting for an opponent · ' + label(state.region);
      button(controls, 'Leave ranked queue', async () => {
        clearTimeout(rankedTimer);
        renderRanked(await mode('duel/ranked/leave', {}));
      });
      rankedTimer = setTimeout(refreshRanked, 1500);
      return;
    }
    const region = choose(controls, 'Match region ', [['asia', 'Asia'], ['europe', 'Europe'], ['americas', 'Americas']]);
    button(controls, 'Find ranked match', async () => {
      const result = await mode('duel/ranked/join', { region: region.value });
      if (page !== origin) return;
      if (result.id) await resumeMatch(result.id);
      else renderRanked(result);
    });
    if (state.lastMatchId) button(controls, 'View last ranked result', () => resumeMatch(state.lastMatchId));
  }

  function problem(error) {
    if (page !== origin || activeRoom) return;
    live = error.message !== 'RANKED_UNAVAILABLE';
    summary.textContent = errors[error.message] ?? 'Could not refresh the ranked queue.';
    controls.replaceChildren();
    if (live) {
      button(controls, 'Retry ranked connection', refreshRanked);
      if (queued) rankedTimer = setTimeout(refreshRanked, 3000);
    }
  }

  function refreshRanked() {
    return mode('duel/ranked').then(renderRanked, problem);
  }

  void refreshRanked();
}
function showRoomEntry(kind, initialId) {
  openLobbyPanel();
  if (kind === 'duel') showRankedEntry(initialId);
  const lobby = lobbyCard(panel, kind === 'coop' ? 'Co-op Room' : 'Private Duel',
    kind === 'coop' ? 'region-emblems-v2/water.png' : 'talismans-v3/gate.png');
  el('p', kind === 'coop' ? 'Three players choose one action each round.' : 'Use a room code to duel a friend.', lobby);
  const controls = group(lobby);
  button(controls, 'Create room', async () => {
    const origin = page;
    const result = await mode(kind, {});
    if (page === origin) connectRoom(kind, result);
  });
  if (kind === 'duel') {
    const practice = lobbyCard(panel, 'Bot Practice', 'talismans-v3/lantern.png');
    el('p', 'Practice your squad against a bot.', practice);
    button(practice, 'Play practice bot', async () => {
      const origin = page;
      const result = await mode('duel/practice', {});
      if (page === origin) connectRoom('duel', result);
    });
  }
  idForm(lobby, 'Room code', initialId ?? stash(kind), async id => {
    const origin = page;
    await mode(roomPath(kind, id) + '/join', {});
    const result = await mode(roomPath(kind, id));
    if (page === origin) connectRoom(kind, result);
  });
}
function connectRoom(kind, state) {
  clearRoom();
  clearTimeout(rankedTimer);
  stash(kind, state.id);
  const connection = activeRoom = { kind, id: state.id };
  updateRoom(connection, state);
  followRoom(connection);
}
function updateRoom(connection, state) {
  if (activeRoom !== connection) return;
  if (JSON.stringify(room) === JSON.stringify(state)) return;
  room = state;
  renderRoom(connection, state);
}
function followRoom(connection) {
  if (activeRoom !== connection) return;
  const { kind, id } = connection;
  if (!room.phase) {
    refreshTimer = setTimeout(async () => {
      try {
        updateRoom(connection, await mode(roomPath(kind, id)));
        if (!socket) followRoom(connection);
      } catch (error) {
        if (activeRoom === connection) feedback(errors[error.message] ?? label(error.message), true);
      }
    }, 1200);
    return;
  }
  if (['won', 'lost', 'abandoned', 'finished'].includes(room.phase)) return;
  const endpoint = new URL('/api/realtime/' + roomPath(kind, id), location.href);
  endpoint.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const connectionSocket = socket = new WebSocket(endpoint);
  connectionSocket.addEventListener('message', event => {
    const packet = JSON.parse(event.data);
    if (packet.type === 'state') updateRoom(connection, packet.state);
  });
  connectionSocket.addEventListener('close', () => {
    if (activeRoom !== connection) return;
    refreshTimer = setTimeout(async () => {
      if (activeRoom !== connection) return;
      try {
        updateRoom(connection, await mode(roomPath(kind, id)));
        followRoom(connection);
      } catch (error) {
        if (activeRoom === connection) feedback(errors[error.message] ?? label(error.message), true);
      }
    }, 1600);
  });
}
function roomBattleMeta(header, state, path) {
  const meta = el('div', null, header);
  meta.className = 'mode-battle-meta';
  if (!state.practice && !state.ranked) {
    const invite = el('a', 'Invite link', meta);
    invite.href = '#' + path;
  }
  if (state.deadline) {
    const at = new Date(state.deadline);
    const deadline = el('time', 'Deadline · ' + at.toLocaleTimeString(), meta);
    deadline.dateTime = at.toISOString();
  }
}
function renderRoom(connection, state) {
  const origin = page;
  const { kind, id } = connection;
  const path = roomPath(kind, id);
  const go = async (action, body = {}) => {
    const result = await mode(path + '/' + action, body);
    // An HTTP response may arrive after a newer WebSocket snapshot.
    if (activeRoom !== connection || room !== state && room.nonce >= (result.nonce ?? -1)) return;
    updateRoom(connection, result);
    if (state.phase === undefined && result.phase && !socket) {
      clearTimeout(refreshTimer);
      followRoom(connection);
    }
  };
  beginEncounter();
  if (state.phase === 'finished') {
    el('h3', state.ranked ? 'Ranked match' : state.practice ? 'Bot practice' : 'Room', encounter);
    const code = el('p', 'Room code · ' + id, encounter);
    code.className = 'muted';
    if (!state.practice && !state.ranked) {
      const invite = el('a', 'Invite link', encounter);
      invite.href = '#' + path;
    }
  }
  const who = id => id === account ? 'You' : id === 'practice-bot' ? 'Practice bot' : id;
  if (!state.phase) {
    document.body.setAttribute('data-waiting', '');
    const lobby = lobbyCard(encounter, 'Room Lobby', 'account-v1/ledger.png');
    const invite = el('a', 'Invite link', lobby);
    invite.href = '#' + path;
    el('p', 'Room code · ' + id + '   /   ' + state.players.length + ' of ' + roomLimits[kind] + ' players', lobby);
    const seats = el('div', null, lobby);
    seats.className = 'mode-room-seats';
    for (let index = 0; index < roomLimits[kind]; index++) {
      const player = state.players[index];
      const ready = state.ready?.includes(player);
      const seat = el('div', null, seats);
      seat.className = 'mode-room-seat';
      if (ready) seat.dataset.ready = '';
      const crest = el('img', null, seat);
      crest.src = asset('talismans-v3/' + ['gate', 'river', 'lantern'][index] + '.png');
      crest.alt = '';
      el('strong', player ? who(player) : 'Open seat', seat);
      el('small', player ? ready ? 'Ready' : 'Preparing' : 'Waiting for player', seat);
    }
    const controls = group(lobby);
    if (!state.ready?.includes(account)) button(controls, 'Ready', () => go('ready'));
    button(controls, 'Back to mode', () => showPage(true));
    return;
  }
  if (state.phase === 'finished') {
    el('p', (state.winner ? who(state.winner) + ' won' : 'Draw') + ' · ' + label(state.reason), encounter);
    if (state.rating) {
      const { current, delta, repeatedPair } = state.rating;
      el('p', 'Rating ' + current + ' (' + (delta > 0 ? '+' : '') + delta + ')', encounter);
      if (repeatedPair) el('p', 'Rating is capped for repeated opponents.', encounter);
      button(encounter, 'Return to ranked queue', () => showPage(true));
    }
    return;
  }
  if (kind === 'duel') {
    const [first, second] = state.players;
    const mine = first.id === account ? first : second;
    const rival = mine === first ? second : first;
    const ownsTurn = state.players[state.turn].id === account;
    const fighters = (side, mirrored) => side.heroes.map(hero => ({
      ...hero, maxHp: 20, key: side.id + ':' + hero.id, name: wardenName(hero.id), mirrored,
      detail: hero.guard ? hero.guard + ' Guard' : '',
    }));
    const view = battlefield('Veil Duel', state.round, 'boss-arena-metal-v1.png',
      fighters(mine), fighters(rival, true),
      state.ranked ? 'Ranked match' : state.practice ? 'Bot practice' : 'Private duel');
    roomBattleMeta(view.header, state, path);
    const stamp = JSON.stringify([id, state.round]);
    const freshRound = origin.rollStamp !== stamp;
    origin.rollStamp = stamp;
    const rolling = [];
    if (state.phase === 'forfeit_grace' && ownsTurn) {
      button(view.controls, 'Resume turn', () => go('resume'));
    } else if (state.phase === 'active') {
      const waiting = ownsTurn ? '' : 'Waiting for ' + who(rival.id);
      if (waiting) view.hint.textContent = waiting;
      for (const die of mine.dice) {
        const action = { nonce: state.nonce, die: die.id, type: die.face };
        const name = label(die.face);
        const side = die.face === 'strike' ? rival : mine;
        const choices = side.heroes.filter(hero => hero.hp > 0).map(hero => side.id + ':' + hero.id);
        const tile = die.face === 'summon'
          ? view.action(name, die.face, die.id, 'party', () => go('act', action), [],
            waiting || (mine.pet || mine.summons >= 3 ? 'Summon unavailable' : ''))
          : view.action(name, die.face, die.id, 'party',
            key => go('act', { ...action, target: key.slice(side.id.length + 1) }), choices,
            waiting || (choices.length ? '' : 'No available targets'));
        if (freshRound) rolling.push(tile);
      }
      if (ownsTurn) button(view.controls, 'Pass die', () => go('act', { nonce: state.nonce, type: 'pass' }));
    } else {
      view.hint.textContent = 'Waiting for ' + who(rival.id);
    }
    playModeRoll(view, rolling);

    return;
  }
  const allies = state.actors.map(actor => ({
    id: actor.heroId, name: wardenName(actor.heroId), hp: actor.hp, maxHp: 20,
    detail: who(actor.accountId) + (actor.action ? ' · ' + label(actor.action) + ' locked' : actor.locked ? ' · Locked' : ''),
  }));
  const boss = { id: 'bell-drowned', name: foes['bell-drowned'].name, hp: state.bossHp, maxHp: 64 };
  const view = battlefield('Co-op Breach', state.round, 'boss-arena-water-v1.png', allies, [boss], label(state.phase));
  roomBattleMeta(view.header, state, path);
  const latest = state.timeline.at(-1);
  if (latest) el('p', latest.actions.map(action => wardenName(action.heroId) + ' · ' + label(action.type) +
    (action.bot ? ' (bot)' : '')).join(' / '), view.header).className = 'mode-battle-meta';
  if (state.entitlements?.length) list(view.controls, state.entitlements.map(item => label(item.itemId) + ' earned'));
  const actor = state.actors.find(actor => actor.accountId === account);
  if (state.phase === 'planning' && actor?.hp && actor.online && !actor.action) {
    for (const type of ['strike', 'guard', 'mend', 'salve']) {
      view.action(label(type), type, actor.heroId, 'party', () => go('act', { nonce: state.nonce, type }),
        [], type === 'salve' && !actor.salves ? 'No salves available' : '');
    }
  } else {
    view.hint.textContent = state.phase === 'planning' ? 'Waiting for teammates' : label(state.phase);
  }

}
async function showRewards() {
  const origin = page;
  const { rewards } = await mode('rewards');
  if (page !== origin) return;
  if (!rewards.length) el('p', 'No mode rewards earned yet.', panel);
  else list(panel, rewards.map(item => label(item.itemId) + ' · ' + label(item.kind) + ' · ' + (names[item.mode] ?? label(item.mode))));
}

async function showPage(focus = false) {
  const match = /^#(trials|weekly|raid|duel|coop|rewards)(?:\/([\w-]{1,100}))?$/.exec(location.hash);
  const kind = match?.[1] ?? 'trials';
  const origin = page = { kind };
  document.body.dataset.mode = kind;
  clearTimeout(rankedTimer);
  clearRoom();
  panel.replaceChildren();
  panel.className = '';
  beginEncounter();
  heading.textContent = names[kind];
  const [emblem, description, boss] = modePresentation[kind];
  document.querySelector('#mode-emblem').src = asset(emblem);
  document.querySelector('#mode-description').textContent = description;
  preview.replaceChildren();
  if (boss) preview.append(wardenPreview(boss, { highResolution: true }));
  else if (kind === 'duel') {
    preview.append(wardenPreview('rook'), wardenPreview('mara'));
  }
  for (const link of nav) {
    if (link.hash === '#' + kind) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (focus) heading.focus();
  feedback('Loading…');
  try {
    const { value, error } = await session;
    if (page !== origin) return;
    if (error?.message === 'SESSION_REQUIRED') {
      const link = el('a', 'Return to Main Menu', panel);
      link.href = './';
      feedback('Sign in to play.');
      return;
    }
    if (error) throw error;
    account = value.playerId;
    if (kind === 'trials') await showTrials();
    else if (kind === 'weekly') await showWeekly();
    else if (kind === 'raid') await showBreach();
    else if (kind === 'rewards') await showRewards();
    else showRoomEntry(kind, match?.[2]);
    if (page === origin) feedback();
  } catch (error) {
    if (page === origin) feedback(errors[error.message] ?? label(error.message), true);
  }
}
window.addEventListener('hashchange', () => void showPage(true));
window.addEventListener('pagehide', () => {
  clearTimeout(rankedTimer);
  clearRoom();
});
window.addEventListener('pageshow', event => { if (event.persisted) void showPage(); });
void showPage();


