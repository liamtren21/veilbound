import { openTitleLogin } from './expedition-title-auth.mjs';
import { Auth0Client } from '@auth0/auth0-spa-js';
import { NearConnector } from '@hot-labs/near-connect';
import { active, describe, canEndRound, rerollableDice, shopInventory } from './expedition-rules.mjs';
import { equipment, ferrymanStages, instantItems, map, regions, story, tokens, training } from './expedition-data.mjs';
import { companions, SUMMON_LIMIT, SUMMON_ROUNDS, BOND_ARRIVAL_DEFENSE } from './expedition-companions.mjs';
import { paintDiceFace } from './expedition-dice-paint.mjs';
import { previewLoadout } from './expedition-loadout-sample.mjs';
import { talismans } from './expedition-progression.mjs';

const account = document.querySelector('#account');
const panel = document.querySelector('#run');
const status = document.querySelector('#status');
let wallet, snapshot, identity, pendingAction, starterPack;
let working = false;
let socialClient;
let inventory;
let loadoutCapabilities = {};
let expeditionHistory = [];
let rewardStorage;
let nearStorageEnabled = false;
let archiveRun;
const journeyLinks = new Map();
const supplyStatus = new Map();
const evolutionQuotes = new Map();
const loadoutAmount = { purse: '0', salve: '0', ward: '0' };

let chosenTalisman = 'gate';
const loadout = { relicToken: '', companionToken: '', chronicleToken: '' };
let operationId;
function upcomingOperation() {
  const key = 'veilbound-expedition-operation-' + identity.playerId;
  operationId ??= sessionStorage.getItem(key) ?? crypto.randomUUID();
  sessionStorage.setItem(key, operationId);
  return operationId;
}

async function api(path, body) {
  const response = await fetch('/api/' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) {
    const messages = {
      NEAR_SOCIAL_ACCOUNT_NEEDS_TESTNEAR: 'Fund your derived NEAR Auth testnet account before signing.',
      NEAR_SOCIAL_STORAGE_UNAVAILABLE: 'There is no reward storage top-up to sign.',
      STARTER_CLAIM_PENDING: 'The starter claim is awaiting confirmation on NEAR testnet. Wait a few seconds and try Claim Starter Pack again.',
      STARTER_LINK_CONFLICT: 'This Starter Pack is linked to another testnet wallet.',
      STARTER_SPEND_PENDING: 'Your previous Starter Pack activity is still settling. Try again shortly.',
      FINISH_ACTIVE_RUN_BEFORE_CLAIM: 'Finish the expedition using your Starter Pack before claiming it to your wallet.',
      WALLET_AUTH_UNAVAILABLE: 'NEAR testnet could not verify your wallet. Reconnect and approve the sign-in message again.',
      challenge_unavailable: 'Your sign-in request expired or no longer matches this tab. Click Connect NEAR Wallet here and approve the new message.',
      PROFESSION_CHECKPOINT_REQUIRED: 'Complete a profession objective or clear a checkpoint first.',
      wallet_key_unavailable: 'Select an account with its full-access key in your NEAR testnet wallet.',
      NFT_LOADOUT_UNAVAILABLE: 'Check ownership or rental rights, and wait for the reservation to finalize.',
      CHRONICLE_BINDING_UNAVAILABLE: 'This Chronicle cannot be bound to the selected run.',
      INVALID_LOADOUT: 'This Talisman is locked for this mode. Clear the preceding Talisman first.',
    };
    throw new Error(messages[value.error] ?? value.error ?? 'Request failed');
  }
  return value;
}
function add(parent, tag, copy) {
  const element = document.createElement(tag);
  element.textContent = copy;
  parent.append(element);
  return element;
}
function button(parent, label, task) {
  const control = add(parent, 'button', label);
  control.disabled = working;
  control.onclick = async () => {
    if (working) return;
    working = true;
    for (const item of document.querySelectorAll('button, select')) item.disabled = true;
    status.textContent = 'Working...';
    try { status.textContent = await task() ?? ''; }
    catch (error) { status.textContent = error.message; }
    finally { working = false; render(); }
  };
  return control;
}
async function resume() {
  identity = await api('session');
  snapshot = await api('runs/active');
  loadoutCapabilities = await api('runs/loadout-capabilities');
  expeditionHistory = identity.accountId ? await api('runs/expedition-history') : [];
  archiveRun = undefined;
  rewardStorage = identity.accountId ? await api('economy/reward-storage').catch(() => undefined) : undefined;
  nearStorageEnabled = Boolean(identity.accountId && (await api('auth/near/transaction').catch(() => null))?.enabled);
  supplyStatus.clear();
  evolutionQuotes.clear();
  pendingAction = undefined;
  starterPack = null;
  try { starterPack = await api('starter'); }
  catch { /* Starter Pack availability does not prevent resuming a run. */ }
  inventory = undefined;
  if (identity.accountId && (!snapshot?.state || ['WON', 'LOST'].includes(snapshot.lifecycle))) {
    try { inventory = await api('runs/expedition-inventory'); }
    catch { inventory = { items: [], unavailable: true }; }
  }
}
const starterItemNames = { salve: 'Salve', ward: 'Ward' };
function starterText(pack) {
  if (pack?.status === 'claimed') return 'Starter Pack claimed';
  if (pack?.status === 'issued') return identity?.accountId ? 'Starter Pack ready to claim' : 'Starter Pack available';
  if (pack?.reason === 'starter_pool_empty') return 'Starter Packs are out of stock';
  if (pack?.reason === 'chain_not_configured') return 'Starter Packs are currently unavailable';
  return 'Starter Pack pending';
}
async function signNearAuthTransaction(input) {
  const popup = window.open('', 'veilbound-fast-auth-transaction', 'popup,width=480,height=640');
  if (!popup) throw new Error('Allow pop-ups to sign.');
  try {
    const { id, bytes, status: txStatus } = await api('auth/near/transaction', input);
    if (!id) return 'Reward status: ' + txStatus;
    const authorizationParams = { audience: 'auth0.jwt.fast-auth.testnet', scope: 'transaction:sign' };
    await socialClient.loginWithPopup({ authorizationParams: { ...authorizationParams, transaction: bytes } }, { popup });
    const verifyPayload = await socialClient.getTokenSilently({ authorizationParams, cacheMode: 'cache-only' });
    const outcome = await api('auth/near/transaction', { id, verifyPayload });
    if (!input.runId) rewardStorage = await api('economy/reward-storage');
    return 'Submitted ' + outcome.transactionHash;
  } finally { popup.close(); }
}
async function send(transaction) {
  if (!identity?.accountId) throw new Error('A NEAR testnet account is required.');
  if (transaction.network !== 'testnet' || transaction.actions?.length !== 1 ||
      transaction.actions[0].type !== 'FunctionCall') throw new Error('Unexpected testnet transaction.');
  if (!wallet) {
    const candidate = await new NearConnector({ network: 'testnet', features: { signAndSendTransaction: true } }).connect();
    const accounts = await candidate.getAccounts({ network: 'testnet' });
    if (!accounts.some(account => account.accountId === identity.accountId)) {
      throw new Error('Select the wallet for ' + identity.accountId + '.');
    }
    wallet = candidate;
  }
  status.textContent = 'Approve in your wallet.';
  const result = await wallet.signAndSendTransaction({ ...transaction, signerId: identity.accountId });
  const hash = result?.transaction?.hash ?? result?.transaction_outcome?.id;
  if (result?.status?.Failure || result?.receipts_outcome?.some(entry => entry.outcome?.status?.Failure)) {
    throw new Error('The transaction failed on chain.' + (hash ? ' Transaction ' + hash : ''));
  }
  if (!hash) throw new Error('Check your wallet activity for this transaction.');
  return 'Submitted ' + hash;
}
async function start(mode) {
  const key = ['veilbound-online-start', mode, chosenTalisman].join('-');
  const rewarded = mode === 'expedition';
  const id = rewarded ? upcomingOperation() : sessionStorage.getItem(key) ?? crypto.randomUUID();
  sessionStorage.setItem(key, id);
  const selections = Object.fromEntries(Object.entries(loadout)
    .filter(([field, token]) => token && (rewarded || field !== 'chronicleToken')));
  snapshot = await api('runs', { mode, talisman: chosenTalisman, operationId: id, ...selections });
  archiveRun = undefined;
  if (rewarded) {
    sessionStorage.removeItem('veilbound-expedition-operation-' + identity.playerId);
    operationId = undefined;
  }
  sessionStorage.removeItem(key);
  if (identity.accountId) expeditionHistory = await api('runs/expedition-history');
  if (rewarded) openExpedition();
}
async function act(intent) {
  if (pendingAction && JSON.stringify(pendingAction.intent) !== JSON.stringify(intent)) {
    throw new Error('Retry the last action or select Continue to refresh.');
  }
  pendingAction ??= { intent, expectedVersion: snapshot.version, operationId: crypto.randomUUID() };
  try {
    snapshot = await api('runs/' + snapshot.runId + '/actions', pendingAction);
    pendingAction = undefined;
  } catch (error) {
    if (['INVALID_ACTION', 'STALE_VERSION', 'RUN_CLOSED'].includes(error.message)) pendingAction = undefined;
    throw error;
  }
}
const option = (label, type, data = {}) => button(panel, label, () => act({ type, ...data }));
function renderBattle(state) {
  const { enemies, dice, round } = state.battle;
  add(panel, 'h3', 'Round ' + round);
  add(panel, 'p', enemies.map(enemy => enemy.name + ' ' + enemy.hp + '/' + enemy.maxHp + ' HP').join(' / '));
  for (const die of dice) {
    const plan = describe(state, die.id);
    if (!plan || plan.reason || (plan.enemy && die.optional)) continue;
    const label = plan.actor.name + ' / ' + plan.name;
    const base = { dieId: die.id, round };
    const choose = plan.choose || (!plan.enemy && !plan.random && plan.targets.length > 1);
    if (choose) for (const target of plan.targets) {
      option(label + ' / ' + target.name, 'use-die', { ...base, targetKey: target.key });
    }
    else option(label, 'use-die', base);
  }
  const actor = active(state.heroes)[0];
  for (const [itemId, item] of Object.entries(tokens)) {
    if (!actor || !state.pack[itemId]) continue;
    const plan = describe(state, 'reserve', { actor: actor.key, action: itemId });
    if (!plan || plan.reason) continue;
    for (const target of plan.targets) {
      option(item.name + ' / ' + target.name, 'use-die', { dieId: 'reserve', round, itemId, targetKey: target.key });
    }
  }
  if (rerollableDice(state).length) option('Reroll', 'reroll', { round });
  if (canEndRound(state)) option('End Turn', 'end-round', { round });
}
function renderReward(state) {
  const offer = state.battle.rewardOffer;
  if (offer?.copper) option('Collect ' + offer.copper + ' Copper', 'claim', { choice: 'copper' });
  if (offer?.token) option('Collect ' + tokens[offer.token].name, 'claim', { choice: 'token' });
  if (offer?.remedy) option('Collect ' + offer.remedy, 'claim', { choice: 'remedy' });
  for (const gear of offer?.gear ?? []) option('Collect ' + equipment[gear].name, 'claim', { choice: 'equipment', heroKey: gear });
  if (offer?.instant) for (const hero of state.heroes) {
    option('Use ' + instantItems[offer.instant].name + ' / ' + hero.name, 'claim', { choice: 'instant', heroKey: hero.key });
  }
  option('Continue expedition', 'claim', { choice: 'leave' });
}
function renderEvent(state) {
  const event = story[state.node];
  if (event?.copy) add(panel, 'p', event.copy);
  for (const [choice, label] of event?.choices ?? []) {
    if (choice !== 'bargain') option(label, 'event', { choice });
    else for (const hero of active(state.heroes)) for (const curseId of ['withered', 'brittle', 'blood-debt']) {
      option(label + ' / ' + hero.name + ' / ' + curseId, 'event', { choice, heroKey: hero.key, curseId });
    }
  }
  if (state.node !== 'trainer') return;
  option('Rest', 'trainer', { choice: 'rest' });
  option('Leave', 'trainer', { choice: 'leave' });
  for (const hero of active(state.heroes)) for (const [choice, lesson] of Object.entries(training)) {
    option(lesson.label + ' / ' + hero.name, 'trainer', { choice, heroKey: hero.key });
  }
}
async function waitForChain(read, done) {
  status.textContent = 'Waiting for NEAR testnet confirmation�';
  for (const ms of [0, 700, 1500, 2700, 4000]) {
    if (ms) await new Promise(resolve => setTimeout(resolve, ms));
    const value = await read().catch(() => undefined);
    if (value && done(value)) return value;
  }
}
async function signOnce(key, transaction, read, done) {
  const storageKey = 'veilbound-pending:' + identity.accountId + ':' + key;
  const submitted = sessionStorage.getItem(storageKey) ?? await send(transaction);
  sessionStorage.setItem(storageKey, submitted);
  const confirmed = await waitForChain(read, done);
  if (confirmed) sessionStorage.removeItem(storageKey);
  return { submitted, confirmed };
}
async function claimReward(path, input) {
  const prepare = () => api(path, input);
  const claim = await prepare();
  if (!claim.transaction) return 'Reward status: ' + claim.status;
  const { submitted, confirmed } = await signOnce(path + JSON.stringify(input), claim.transaction,
    prepare, result => !result.transaction);
  return confirmed ? 'Reward status: ' + confirmed.status : submitted + ' � Awaiting confirmation.';
}
function renderCheckpoints(run = snapshot, container = panel) {
  const { runId, checkpoints } = run;
  for (const checkpoint of checkpoints ?? []) {
    const prefix = 'runs/' + runId + '/';
    const bankInput = { region: checkpoint.region };
    button(container, 'Bank checkpoint ' + checkpoint.region, () => claimReward(prefix + 'prepare-bank', bankInput));
    if (socialClient && nearStorageEnabled) {
      button(container, 'Bank checkpoint ' + checkpoint.region + ' via NEAR Auth',
        () => signNearAuthTransaction({ runId, ...bankInput }));
    }
    for (const material of checkpoint.materials ?? []) {
      const input = { entitlementId: material.entitlementId };
      button(container, 'Claim ' + material.itemId, () => claimReward(prefix + 'prepare-material-claim', input));
      add(container, 'a', 'Find buyers for ' + material.itemId).href =
        './economy.html?' + new URLSearchParams({ material: material.itemId }) + '#materials';
    }
  }
}
let fieldContracts;
let selectedContract;
let contractNotice;
const fieldViewKey = () => JSON.stringify([snapshot?.state.node, snapshot?.state.phase, snapshot?.checkpoints?.length]);
async function refreshFieldContracts(runId) {
  const viewKey = fieldViewKey();
  const details = await api('field-contracts/run/' + runId);
  if (snapshot?.runId === runId && fieldViewKey() === viewKey) fieldContracts = { runId, viewKey, ...details };
}
function renderFieldContracts(runId, container = panel) {
  const section = add(container, 'section', '');
  section.className = 'contract-board';
  add(section, 'h3', 'Field Contracts');
  if (contractNotice?.runId === runId) {
    const notice = add(section, 'p', contractNotice.message);
    notice.className = 'contract-notice';
    notice.setAttribute('role', 'status');
  }
  if (fieldContracts?.runId !== runId || fieldContracts.viewKey !== fieldViewKey()) {
    void refreshFieldContracts(runId).then(() => {
      if (fieldContracts?.runId === runId && fieldContracts.viewKey === fieldViewKey() && section.isConnected) render();
    }).catch(error => {
      if (section.isConnected) {
        add(section, 'p', error.message);
        button(section, 'Retry', () => refreshFieldContracts(runId));
      }
    });
    return;
  }
  if (!fieldContracts.enabled) {
    add(section, 'p', 'Field Contracts are currently unavailable.');
    return;
  }
  const nodeName = node => map[node]?.name ?? node;
  const copperLabel = value => {
    const digits = value.padStart(3, '0');
    return digits.slice(0, -2) + '.' + digits.slice(-2) + ' Copper';
  };
  const offers = fieldContracts.offers;
  if (offers.length) {
    const list = add(section, 'div', '');
    list.className = 'contract-offers';
    const preview = add(section, 'div', '');
    preview.className = 'contract-preview';
    const cards = [];
    for (const offer of offers) {
      const card = add(list, 'button', nodeName(offer.objective));
      card.type = 'button';
      card.disabled = working;
      const objective = map[offer.objective];
      const art = add(card, 'img', '');
      art.alt = '';
      art.src = 'combat-assets/' + locationArtwork(objective);
      card.prepend(art);
      cards.push([offer, card]);
      card.onclick = () => selectOffer(offer);
    }
    function selectOffer(offer) {
      selectedContract = offer.id;
      for (const [entry, card] of cards) card.setAttribute('aria-pressed', String(entry.id === offer.id));
      preview.replaceChildren();
      const route = add(preview, 'div', '');
      add(route, 'strong', nodeName(offer.objective) + ' → ' + nodeName(offer.delivery));
      const reward = add(route, 'span', copperLabel(offer.rewardAtomic));
      reward.className = 'gate-copper';
      const accept = button(preview, 'Accept Contract', async () => {
        accept.textContent = 'Accepting…';
        try {
          const contract = await api('field-contracts/accept', { runId, offerId: offer.id });
          const contracts = fieldContracts.contracts.filter(entry => entry.id !== contract.id);
          fieldContracts = { ...fieldContracts, contracts: [...contracts, contract],
            offers: fieldContracts.offers.filter(entry => entry.id !== offer.id) };
          contractNotice = { runId, message: contract.status === 'accepted'
            ? nodeName(offer.objective) + ' accepted. Copper is paid automatically after the objective and checkpoint.'
            : nodeName(offer.objective) + ' · ' + contract.status };
        } catch (error) {
          const messages = {
            CONTRACT_ACTIVE_LIMIT: 'You already have two active contracts.',
            CONTRACT_SETTLEMENT_PENDING: 'Reservation pending. The game will keep checking it.',
            CONTRACT_UNREACHABLE: 'This route is no longer reachable.',
          };
          contractNotice = { runId, message: messages[error.message] ?? 'Could not accept the contract: ' + error.message };
        }
        await refreshFieldContracts(runId).catch(() => {});
      });
    }
    selectOffer(offers.find(offer => offer.id === selectedContract) ?? offers[0]);
  } else {
    add(section, 'p', 'No contracts available.');
  }
  for (const contract of fieldContracts.contracts) {
    const entry = add(section, 'div', '');
    entry.className = 'contract-active';
    const states = { accepted: contract.canDeliver ? 'Completed · Payout pending' : 'Active', reserving: 'Reserving',
      paying: 'Payout pending', paid: 'Paid', releasing: 'Releasing', cancelled: 'Cancelled', expired: 'Expired' };
    add(entry, 'strong', nodeName(contract.objective));
    add(entry, 'span', copperLabel(contract.rewardAtomic) + ' · ' + (states[contract.status] ?? contract.status));
    const controls = {
      accepted: contract.canDeliver ? [] : [['Cancel contract', 'cancel']],
      reserving: [['Check reservation', 'recover']],
      paying: [['Check payout', 'recover']],
      releasing: [['Check release', 'recover']],
    }[contract.status] ?? [];
    for (const [label, action] of controls) {
      button(entry, label, async () => {
        const updated = await api('field-contracts/' + contract.id + '/' + action, {});
        await refreshFieldContracts(runId);
        return 'Contract status: ' + updated.status;
      });
    }
  }
}
const sampleFaceNames = {strike:'Strike', summon:'Summon', idle:'Wait', rotate:'Rotate'};

function loadoutComparison(parent, preview, companionId) {
  if (!preview) {
    add(parent, 'p', 'The required warden is outside this Talisman’s active squad.');
    return;
  }
  const board = add(parent, 'div', '');
  board.className = 'loadout-comparison';
  const comparison = [
    ['Without NFT', 'before', preview.before?.defense],
    ['With NFT', 'after', preview.after?.defense],
  ];
  for (const [heading, side, defense] of comparison) {
    const column = add(board, 'div', '');
    add(column, 'strong', heading);
    for (const change of preview.changes) {
      const row = add(column, 'div', '');
      row.className = 'loadout-preview-row';
      const key = change[side];
      const tile = add(row, 'span', '');
      tile.className = 'loadout-preview-tile face';
      tile.setAttribute('aria-hidden', 'true');
      paintDiceFace(tile, key === 'summon' ? companionId : preview.hero.id, key, 'party');
      add(row, 'span', (change.die ? 'Die ' + change.die + ' · ' : '') + (sampleFaceNames[key] ?? key) +
        (defense === undefined ? '' : ' · +' + defense + ' Defense'));
    }
  }
  const details = add(parent, 'details', '');
  details.className = 'loadout-sample-result';
  add(details, 'summary', 'Show sample outcome');
  add(details, 'p', 'The Listening Road · Fixed demonstration action');
  const events = add(details, 'ul', '');
  for (const line of preview.result ?? preview.after.result) add(events, 'li', line);
}

function renderLoadoutSample() {
  const details = add(panel, 'details', '');
  details.className = 'hall-sample';
  add(details, 'summary', 'Preview an NFT loadout');
  add(details, 'h4', 'The Gate Wardens · Flintback');
  loadoutComparison(details, previewLoadout('gate', {companionId:'flintback'}), 'flintback');
  add(details, 'h4', 'The Gate Wardens · Ferryman’s Cord');
  loadoutComparison(details, previewLoadout('gate', {relicStage:0}));
}

function renderLoadout() {
  const section = add(panel, 'section', '');
  section.className = 'hall-loadout';
  add(section, 'h3', 'Loadout');
  const slots = add(section, 'div', '');
  slots.className = 'hall-slots';
  for (const [key, name] of [['relicToken', 'Relic'], ['companionToken', 'Companion'], ['chronicleToken', 'Chronicle']]) {
    if (key === 'chronicleToken' && !loadoutCapabilities.chronicle) continue;
    const slot = add(slots, 'section', '');
    slot.className = 'hall-slot';
    add(slot, 'h4', name);
    const kind = key === 'companionToken' ? 'COMPANION_BOND' : 'RELIC';
    const items = (inventory?.items ?? []).filter(item => item.kind === kind && (key !== 'chronicleToken' || item.ready));
    const choices = add(slot, 'div', '');
    choices.className = 'hall-items';
    if (!items.length) {
      const empty = add(choices, 'div', inventory?.unavailable ? 'Inventory unavailable' : 'Empty slot');
      empty.className = 'hall-empty';
      empty.dataset.kind = name.toLowerCase();
    }
    for (const item of items) {
      const tile = button(choices, item.title, () => { loadout[key] = loadout[key] === item.id ? '' : item.id; });
      tile.className = 'hall-item';
      tile.dataset.kind = name.toLowerCase();
      tile.setAttribute('aria-pressed', String(loadout[key] === item.id));
    }
    const selected = items.find(item => item.id === loadout[key]);
    if (selected && key === 'relicToken') {
      const cord = equipment['ferryman-cord'];
      const stage = ferrymanStages[selected.stage] ?? ferrymanStages[0];
      add(slot, 'p', 'Mara Venn · ' + cord.name + ' · ' + stage.name);
      add(slot, 'p', stage.text + ' Uses an equipment slot.');
      loadoutComparison(slot, previewLoadout(chosenTalisman, {relicStage:ferrymanStages.indexOf(stage)}));
    }
    if (selected && key === 'companionToken' && Object.hasOwn(companions, selected.companion)) {
      const companion = companions[selected.companion];
      add(slot, 'p', companion.name + ' · ' + companion.bond);
      add(slot, 'p', companion.skill + ' · ' + companion.text);
      add(slot, 'p', SUMMON_LIMIT + ' summons per battle · ' + SUMMON_ROUNDS + ' rounds per summon.');
      add(slot, 'p', 'When the bonded warden leads, Summon replaces Strike. On arrival the bonded warden gains ' + BOND_ARRIVAL_DEFENSE + ' Defense.');
      loadoutComparison(slot, previewLoadout(chosenTalisman, {companionId:selected.companion}), selected.companion);
    }
    if (loadout[key] && key !== 'chronicleToken') button(slot, 'Reserve ' + name, async () => {
      const { transaction } = await api('runs/prepare-nft-lock', { tokenId: loadout[key], operationId: upcomingOperation() });
      return send(transaction);
    });
  }
  if (inventory?.next) button(section, 'More items', async () => {
    const next = await api('runs/expedition-inventory?offset=' + encodeURIComponent(inventory.next));
    inventory = { items: [...inventory.items, ...next.items], next: next.next };
  });
  if (inventory?.unavailable) button(section, 'Reload inventory', resume);
  if (!inventory?.unavailable && !(inventory?.items ?? []).length) add(section, 'p', 'You can start with an empty loadout.');
}
function loadoutCount(section, key, name, max, fixed) {
  const input = add(add(section, 'label', name + ' '), 'input', '');
  input.type = 'number';
  input.min = '0';
  input.max = String(max);
  input.step = '1';
  input.value = fixed ?? loadoutAmount[key];
  input.readOnly = fixed !== undefined;
  input.oninput = () => { loadoutAmount[key] = input.value; };
}
function readLoadoutCount(key, max) {
  const value = loadoutAmount[key];
  if (!/^(0|[1-9][0-9]*)$/.test(value) || Number(value) > max) {
    throw new Error('Enter a whole number from 0 to ' + max + '.');
  }
  return Number(value);
}
function renderRunCustody(run = snapshot, container = panel) {
  const { runId, state, version, lifecycle, checkpoints, loadoutPreparation: preparation = {} } = run;
  const terminal = ['WON', 'LOST'].includes(lifecycle);
  const prefix = 'runs/' + runId + '/';
  const section = add(container, 'section', '');
  const { purseAtomic, ownedItems, chronicleToken } = preparation;
  const submit = (label, path, body = {}) => button(section, label, async () => {
    const tx = await api(prefix + path, body);
    const result = await send(tx);
    supplyStatus.delete(runId);
    return result;
  });
  const update = (label, path) => button(section, label, async () => {
    snapshot = await api(prefix + path, {});
  });
  if (!loadoutCapabilities.purse && !loadoutCapabilities.items && !chronicleToken) {
    section.remove();
    return;
  }
  add(section, 'h3', 'Expedition supplies');
  if (version === 0 && !ownedItems && loadoutCapabilities.purse) {
    loadoutCount(section, 'purse', 'Copper to carry', 40, purseAtomic ? String(Number(purseAtomic) / 100) : undefined);
    button(section, 'Reserve Copper', async () => {
      const amountAtomic = purseAtomic ?? String(readLoadoutCount('purse', 40) * 100);
      if (amountAtomic === '0') throw new Error('Enter at least 1 Copper.');
      const tx = await api(prefix + 'vault-purse/prepare', { amountAtomic });
      snapshot = await api('runs/' + runId);
      const { submitted, confirmed } = await signOnce(prefix + 'vault-purse', tx,
        () => api(prefix + 'vault-purse/confirm', {}), result => Boolean(result.runId));
      if (confirmed) snapshot = confirmed;
      return confirmed ? 'Copper reserved.' : submitted + ' � Awaiting confirmation.';
    });
    if (purseAtomic) {
      update('Cancel Copper preparation', 'vault-purse/cancel');
    }
  }
  if (version === 0 && !purseAtomic && loadoutCapabilities.items) {
    loadoutCount(section, 'salve', 'Salves to carry', 5, ownedItems ? ownedItems.salve ?? '0' : undefined);
    loadoutCount(section, 'ward', 'Wards to carry', 5, ownedItems ? ownedItems.ward ?? '0' : undefined);
    button(section, 'Reserve owned items', async () => {
      const items = ownedItems ? Object.fromEntries(Object.entries(ownedItems).map(([id, count]) => [id, Number(count)]))
        : Object.fromEntries(['salve', 'ward'].map(id => [id, readLoadoutCount(id, 5)]).filter(([, count]) => count > 0));
      if (!Object.keys(items).length) throw new Error('Choose at least one item.');
      const tx = await api(prefix + 'owned-items/prepare', { items });
      snapshot = await api('runs/' + runId);
      const { submitted, confirmed } = await signOnce(prefix + 'owned-items', tx,
        () => api(prefix + 'owned-items/confirm', {}), result => Boolean(result.runId));
      if (confirmed) snapshot = confirmed;
      return confirmed ? 'Items reserved.' : submitted + ' � Awaiting confirmation.';
    });
    if (ownedItems) {
      update('Cancel item preparation', 'owned-items/cancel');
    }
  }
  if (terminal) {
    const path = journeyLinks.get(runId);
    if (path) {
      const link = add(section, 'a', 'Open shared Chronicle');
      link.href = path;
    } else {
      button(section, 'Share Chronicle', async () => {
        const result = await api('runs/' + runId + '/share-journey', {});
        journeyLinks.set(runId, result.path);
      });
    }
  }
  const hasPurse = terminal && state.vaultPurse && loadoutCapabilities.purse;
  const hasItems = terminal && state.ownedRemaining && loadoutCapabilities.items;
  if (hasPurse || hasItems) {
    button(section, 'Check finalized supply status', async () => {
      supplyStatus.set(runId, await api(prefix + 'supply-status'));
    });
    const finalized = supplyStatus.get(runId);
    for (const [available, key, label, path] of [
      [hasPurse, 'purse', 'Copper purse', 'vault-purse/close'],
      [hasItems, 'items', 'Owned items', 'owned-items/close'],
    ]) {
      if (!available) continue;
      const status = finalized?.[key];
      if (status) add(section, 'p', label + ': ' + status);
      if (status !== 'settled' && status !== 'unreserved') submit('Settle ' + label.toLowerCase(), path);
    }
  }
  if (loadoutCapabilities.chronicle && chronicleToken) {
    for (const [region, achievement] of [[3, 'region-3-clear'], [5, 'five-region-clear']]) {
      if (checkpoints.some(checkpoint => checkpoint.region === region)) {
        const key = runId + '/' + achievement;
        const readQuote = () => api(prefix + 'quote-evolution', { achievement });
        const quote = evolutionQuotes.get(key);
        if (!quote) {
          evolutionQuotes.set(key, { status: 'loading' });
          void readQuote().then(result => evolutionQuotes.set(key, result),
            () => evolutionQuotes.set(key, { status: 'unavailable' })).then(() => {
            if (!working && section.isConnected) render();
          });
        }
        if (!quote || quote.status === 'loading') {
          add(section, 'p', 'Checking Relic evolution�');
          continue;
        }
        if (quote.status === 'unavailable') {
          button(section, 'Retry evolution check', async () => {
            evolutionQuotes.set(key, await readQuote());
          });
          continue;
        }
        if (quote.status === 'milestone_pending') {
          button(section, 'Record milestone', async () => {
            const transaction = await api(prefix + 'prepare-chronicle', { achievement });
            const { confirmed, submitted } = await signOnce(key + ':milestone', transaction,
              readQuote, result => result.status !== 'milestone_pending');
            if (confirmed) evolutionQuotes.set(key, confirmed);
            return confirmed ? 'Milestone recorded.' : submitted + ' � Awaiting confirmation.';
          });
        }
        const messages = {
          milestone_pending: 'The Chronicle milestone is awaiting on-chain confirmation.',
          evolved: 'Evolution confirmed on chain.',
          previous_stage_required: 'Complete the previous evolution first.',
          recipe_unavailable: 'The evolution recipe is unavailable on this network.',
          relic_locked: 'Release the Relic rental or Expedition lock before evolving it.',
          resources_needed: quote.missing && 'Required before evolving: ' +
            [quote.missing.copper && 'Copper', quote.missing.storage && 'Core storage credit', ...quote.missing.items]
              .filter(Boolean).join(', ') + '.',
        };
        if (quote.cost) {
          const cost = quote.cost.items.map(item => item.quantity + ' × ' + item.id);
          add(section, 'p', ['Evolution cost', Number(quote.cost.copperAtomic) / 100 + ' Copper', ...cost].join(' / '));
        }
        if (quote.status === 'ready') {
          button(section, 'Evolve Relic', async () => {
            const latest = await readQuote();
            evolutionQuotes.set(key, latest);
            if (latest.status !== 'ready') return messages[latest.status] ?? 'Evolution terms changed.';
            if (JSON.stringify(quote.cost) !== JSON.stringify(latest.cost)) return 'Evolution cost changed. Check the new cost.';
            const { submitted, confirmed } = await signOnce(key + ':evolve', latest.transaction,
              readQuote, result => result.status === 'evolved');
            if (confirmed) evolutionQuotes.set(key, confirmed);
            return confirmed ? 'Evolution confirmed on chain.' : submitted + ' � Awaiting confirmation.';
          });
        } else if (messages[quote.status]) add(section, 'p', messages[quote.status]);
      }
    }
  }
  if (section.childElementCount === 1) section.remove();
}

function renderExpeditionHistory() {
  const entries = expeditionHistory.filter(entry => entry.runId !== snapshot?.runId);
  if (!entries.length) return;
  const details = add(panel, 'details', '');
  add(details, 'summary', 'Past Expeditions');
  details.open = Boolean(archiveRun);
  for (const entry of entries) {
    button(details, entry.outcome + ' / ' + entry.runId.slice(0, 8), async () => {
      archiveRun = await api('runs/' + entry.runId);
    });
  }
  if (archiveRun) {
    renderRunCustody(archiveRun, details);
    renderCheckpoints(archiveRun, details);
  }
}

function locationArtwork(node) {
  const art = node?.art ?? 'orchard-threshold';
  return art.endsWith('.png') ? art : 'wood-' + art + '-v1.png';
}
function renderGateSupplies(container, state) {
  const stock = add(container, 'div', '');
  stock.className = 'gate-stock';
  for (const [name, value, icon] of [
    ['Copper', state.copper, 'copper'],
    ['Reed Salve', state.pack?.salve ?? 0, 'salve'],
    ['Bark Ward', state.pack?.['guard-token'] ?? 0, 'ward'],
  ]) {
    const tile = add(stock, 'div', '');
    tile.dataset.supply = icon;
    add(tile, 'strong', String(value));
    add(tile, 'span', name);
  }
  const chronicleReady = loadoutCapabilities.chronicle && snapshot.loadoutPreparation?.chronicleToken &&
    snapshot.checkpoints?.some(checkpoint => [3, 5].includes(checkpoint.region));
  if (identity.accountId && (snapshot.version === 0 && (loadoutCapabilities.purse || loadoutCapabilities.items) || chronicleReady)) {
    renderRunCustody(snapshot, container);
  }
}
function renderGateProgress(container) {
  const checkpoints = snapshot.checkpoints ?? [];
  const cleared = new Set(checkpoints.map(checkpoint => checkpoint.region));
  add(container, 'h3', 'Regional progress');
  const track = add(container, 'progress', '');
  track.className = 'gate-region-progress';
  track.max = regions.length;
  track.value = cleared.size;
  track.setAttribute('aria-label', 'Regions cleared');
  add(container, 'p', cleared.size + ' / ' + regions.length + ' regions cleared');
  const list = add(container, 'ol', '');
  list.className = 'gate-region-list';
  for (const region of regions) {
    const tile = add(list, 'li', '');
    tile.dataset.cleared = String(cleared.has(region.number));
    const emblem = add(tile, 'img', '');
    emblem.src = 'combat-assets/region-emblems-v2/' + region.id + '.png';
    emblem.alt = '';
    emblem.width = emblem.height = 144;
    add(tile, 'strong', region.name);
    add(tile, 'small', cleared.has(region.number) ? 'Cleared' : 'Pending');
  }
  if (!checkpoints.length) return;
  renderCheckpoints(snapshot, container);
  button(container, 'Sync Profession', async () => {
    const progress = await api('professions/record', { runId: snapshot.runId });
    return progress.unlocked.length ? 'Specialties unlocked: ' + progress.unlocked.join(', ') : 'Profession progress synced.';
  });
}
function renderExpeditionScene(state) {
  const stage = add(panel, 'div', '');
  stage.className = 'orchard-gate';
  stage.style.setProperty('--gate-landscape', 'url("combat-assets/' + locationArtwork(map[state.node]) + '")');
  const heading = add(stage, 'header', '');
  add(heading, 'h2', map[state.node].name);
  const copper = add(heading, 'span', state.copper + ' Copper');
  copper.className = 'gate-copper';
  const roster = add(stage, 'div', '');
  roster.className = 'starter-roster gate-roster';
  for (const hero of state.heroes) {
    const card = add(roster, 'figure', '');
    card.className = 'starter-portrait';
    const portrait = add(card, 'span', '');
    portrait.className = 'starter-avatar';
    const face = add(portrait, 'img', '');
    face.src = 'combat-assets/warden-avatars-v1/' + hero.id + '.png';
    face.alt = '';
    const caption = add(card, 'figcaption', hero.name);
    if (hero.bench) {
      card.classList.add('starter-reserve');
      const badge = add(caption, 'small', 'Reserve');
      badge.className = 'starter-reserve-badge';
    }
    const footer = add(card, 'div', '');
    footer.className = 'gate-hero-health';
    const health = add(footer, 'meter', '');
    health.max = hero.maxHp;
    health.value = hero.hp;
    health.setAttribute('aria-label', hero.name + ' health');
    add(footer, 'small', hero.hp + ' / ' + hero.maxHp);
  }
  const scene = add(stage, 'div', '');
  scene.className = 'gate-dialogue';
  if (state.node === 'threshold') add(scene, 'p', story.threshold.copy);
  const pending = snapshot.version === 0 && Boolean(snapshot.loadoutPreparation?.purseAtomic || snapshot.loadoutPreparation?.ownedItems);
  if (pending) add(scene, 'p', 'Confirm or cancel your reserved supplies to continue.');
  if (snapshot.mode === 'expedition') addPlayExpedition(scene).disabled ||= pending;
  else for (const [choice, label] of story[state.node].choices) {
    button(scene, label, () => act({ type: 'event', choice }));
  }
  if (snapshot.mode !== 'expedition') return;
  const tools = add(stage, 'div', '');
  tools.className = 'gate-tools';
  const disclosure = (label, icon, content) => {
    const details = add(tools, 'details', '');
    details.setAttribute('name', 'gate-tools');
    const key = snapshot.runId + ':' + label;
    details.open = gateDisclosures.has(key);
    details.ontoggle = () => {
      if (details.open) gateDisclosures.add(key);
      else gateDisclosures.delete(key);
    };
    const summary = add(details, 'summary', label);
    summary.dataset.icon = icon;
    const drawer = add(details, 'div', '');
    drawer.className = 'gate-drawer';
    content(drawer);
  };
  disclosure('Supplies', 'supplies', details => renderGateSupplies(details, state));
  disclosure('Contracts', 'contracts', details => renderFieldContracts(snapshot.runId, details));
  disclosure('Kit', 'supplies', details => {
    details.append(...account.childNodes);
    account.hidden = true;
  });
  disclosure('Progress', 'progress', renderGateProgress);
}
function openExpedition() {
  location.assign('/?expedition=' + encodeURIComponent(snapshot.runId));
}
const addPlayExpedition = parent => button(parent, snapshot.version ? 'Resume' : 'Play Expedition', openExpedition);
const gateDisclosures = new Set();
async function connectExpeditionWallet() {
  await openTitleLogin('wallet');
  wallet = undefined;
  await resume();
  if (!identity?.accountId) throw new Error('Wallet verification did not complete.');
  return 'Wallet connected: ' + identity.accountId;
}
function render() {
  account.replaceChildren();
  panel.replaceChildren();
  panel.classList.toggle('hall-at-gate', Boolean(snapshot?.state && (
    snapshot.mode === 'expedition' && !['WON', 'LOST'].includes(snapshot.lifecycle) ||
    snapshot.state.node === 'threshold' && snapshot.state.phase === 'event'
  )));
  account.hidden = false;
  account.classList.toggle('hall-needs-wallet', !identity?.accountId);
  if (!identity?.accountId) {
    add(account, 'h2', 'Connect your wallet');
    add(account, 'p', 'Use a NEAR testnet wallet for Starter Pack claims and Expedition rewards.');
    button(account, 'Connect NEAR Wallet', connectExpeditionWallet);
    if (!identity) {
      panel.hidden = true;
      return;
    }
  }
  panel.hidden = false;
  add(account, 'h2', 'Expedition Kit');
  if (identity.accountId) {
    const badge = add(account, 'p', identity.accountId);
    badge.className = 'hall-account-badge';
  }
  button(account, 'Refresh', resume);
  add(account, 'p', starterText(starterPack));
  if (starterPack?.inventory) {
    const { copper, token_ids: ids, quantities } = starterPack.inventory;
    const items = ids.map((id, index) => quantities[index] + ' × ' + (starterItemNames[id] ?? id));
    add(account, 'p', [starterPack.relicId, Number(copper) / 100 + ' Copper', ...items].join(' / '));
  }
  if (starterPack?.status !== 'claimed' && identity.accountId && starterPack?.claimAvailable) {
    button(account, 'Claim Starter Pack', async () => {
      if (starterPack.status !== 'issued') {
        starterPack = await api('starter/provision', {});
        if (starterPack.status !== 'issued') return starterText(starterPack);
      }
      const prepared = await api('starter/prepare-claim', {});
      if (!prepared.transaction) {
        starterPack = await api('starter');
        return starterText(starterPack);
      }
      const { submitted, confirmed } = await signOnce('starter:' + prepared.grantId, prepared.transaction,
        () => api('starter'), result => result.status === 'claimed');
      starterPack = confirmed ?? starterPack;
      return confirmed ? starterText(starterPack) : submitted + ' � Awaiting confirmation.';
    });
  } else if (!identity.accountId && !['issued', 'claimed'].includes(starterPack?.status)) {
    button(account, 'Get Starter Pack', async () => {
      starterPack = await api('starter/provision', {});
      return starterText(starterPack);
    });
  }
  if (!snapshot?.state || ['WON', 'LOST'].includes(snapshot.lifecycle)) {
    add(panel, 'h2', 'Prepare Expedition');
    const talismanField = add(panel, 'div', '');
    talismanField.className = 'hall-talismans';
    for (const talisman of talismans) {
      const tile = button(talismanField, talisman.name, () => { chosenTalisman = talisman.id; });
      tile.className = 'hall-item';
      tile.setAttribute('aria-pressed', String(chosenTalisman === talisman.id));
      const art = document.createElement('img');
      art.src = 'combat-assets/talismans-v3/' + talisman.id + '.png';
      art.alt = '';
      tile.prepend(art);
    }
    if (identity.accountId) renderLoadout();
    renderLoadoutSample();
    const actions = add(panel, 'div', '');
    actions.className = 'hall-actions';
    if (identity.accountId) button(actions, 'Start', () => start('expedition'));
    else add(panel, 'p', 'Verify your NEAR testnet wallet to unlock Rewarded Expedition and reward storage.');
  }
  if (identity.accountId) {
    if (!rewardStorage) button(account, 'Retry storage check', async () => {
      rewardStorage = await api('economy/reward-storage');
    });
    if (rewardStorage?.transaction) {
      const deposit = rewardStorage.deposit.padStart(25, '0');
      const amount = deposit.slice(0, -24) + '.' + deposit.slice(-24).replace(/0+$/, '');
      if (socialClient && nearStorageEnabled) {
        button(account, 'Fund reward storage via NEAR Auth (' + amount + ' testNEAR)', () => signNearAuthTransaction({}));
      }
      button(account, 'Fund reward storage (' + amount + ' testNEAR)', async () => {
        const { submitted, confirmed } = await signOnce('reward-storage', rewardStorage.transaction,
          () => api('economy/reward-storage'), value => !value.transaction);
        rewardStorage = confirmed ?? rewardStorage;
        return confirmed ? 'Reward storage is funded.' : submitted + ' � Awaiting confirmation.';
      });
    } else if (rewardStorage) {
      add(account, 'p', 'Reward storage is funded.');
    }
    renderExpeditionHistory();
  }
  if (!snapshot?.state) return;
  const { state } = snapshot;
  if (panel.classList.contains('hall-at-gate')) {
    renderExpeditionScene(state);
    return;
  }
  add(panel, 'h2', map[state.node]?.name ?? state.node);
  add(panel, 'p', state.report ?? state.phase);
  add(panel, 'p', state.heroes.map(hero => hero.name + ' ' + hero.hp + '/' + hero.maxHp + ' HP').join(' / '));
  add(panel, 'p', state.copper + ' Copper');
  if (state.starterInventory && !['WON', 'LOST'].includes(snapshot.lifecycle)) {
    const pack = state.starterInventory;
    const items = Object.entries(pack.remaining).filter(([, quantity]) => quantity > 0)
      .map(([id, quantity]) => quantity + ' × ' + (starterItemNames[id] ?? id));
    add(panel, 'p', 'Starter Pack in this run: ' + [pack.copper + ' Copper', ...items].join(' / '));
  }
  if (['event', 'map', 'shop'].includes(state.phase) && state.pack.salve > 0) {
    for (const hero of state.heroes.filter(hero => hero.hp > 0 && hero.hp < hero.maxHp)) {
      option('Use Reed Salve on ' + hero.name, 'salve', { heroKey: hero.key });
    }
  }
  if (state.phase === 'event') renderEvent(state);
  if (state.phase === 'map') for (const next of snapshot.availableNodes) {
    option(map[next.id]?.name ?? next.id, 'enter', { node: next.id });
  }
  if (state.phase === 'shop') {
    for (const item of shopInventory(structuredClone(state))) option(item.name + ' / ' + item.price, 'buy', { itemId: item.id });
    option('Leave the shop', 'leave-shop');
  }
  if (state.phase === 'battle') renderBattle(state);
  if (state.phase === 'reward') renderReward(state);
  if (snapshot.mode === 'expedition') {
    if (identity.accountId) renderRunCustody();
    renderFieldContracts(snapshot.runId);
    renderCheckpoints();
    button(panel, 'Record profession quest progress', async () => {
      const progress = await api('professions/record', { runId: snapshot.runId });
      return progress.unlocked.length ? 'Specialties unlocked: ' + progress.unlocked.join(', ') : 'Profession quest progress recorded.';
    });
  }
}
render();
void resume().then(render, error => {
  if (error.message !== 'SESSION_REQUIRED') status.textContent = error.message;
});

void api('auth/near/config').then(config => {
  if (!config.enabled || !config.clientId) return;
  socialClient = new Auth0Client({ domain: 'login.testnet.fast-auth.com', clientId: config.clientId });
  render();
}).catch(() => {});

