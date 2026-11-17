import { craftingCatalog } from './shared/crafting.mjs';
import { NearConnector } from '@hot-labs/near-connect';

const $ = id => document.getElementById(id);
const connector = new NearConnector({
  network: 'testnet',
  features: { signMessage: true, signAndSendTransaction: true },
});
const feedback = {
  PROFESSION_SPECIALTY_REQUIRED: 'Choose the matching specialty or use the public workshop.',
  PROFESSION_LOCKED: 'This specialty is still locked.',
  PROFESSION_CHECKPOINT_REQUIRED: 'Clear an Expedition checkpoint before recording progress.',
  PROFESSION_EXPEDITION_REQUIRED: 'Use a rewarded Expedition run to unlock specialties.',
  SESSION_REQUIRED: 'Connect your testnet wallet to start a session.',
  LINKED_CHAIN_ACCOUNT_REQUIRED: 'Link a testnet wallet to this game profile.',
  profile_conflict: 'This wallet belongs to a different game profile.',
  ECONOMIC_OPERATION_UNAVAILABLE: 'The market could not complete this request. Refresh and check the current terms.',
  INTENTS_PREVIEW_UNAVAILABLE: 'The Tidepool testnet preview is unavailable. Try again later.',
  charter_unavailable: 'This Charter is listed, transferring, or unavailable. Refresh your Charters.',
  shop_funding_unavailable: 'Your market balance does not cover this funding request.',
  order_unavailable: 'This order is closed or no longer available.',
  NOT_FOUND: 'The economy API is unavailable on this server.',
};
let wallet;
let accountId;
let salesCursor = null;
let busy = false;
const marketParams = new URLSearchParams(location.search);
const materialFilter = marketParams.get('material');
const materialSide = marketParams.get('side') === 'sell' ? 'Sell' : 'Buy';
const marketPages = [...document.querySelectorAll('.market-page')];
const marketLinks = [...document.querySelectorAll('nav[aria-label="Market sections"] a')];
function showMarketAction(page, action) {
  for (const button of page.querySelectorAll('[data-market-action]')) {
    button.setAttribute('aria-pressed', String(button.dataset.marketAction === action));
  }
  for (const pane of page.querySelectorAll('[data-market-pane]')) {
    pane.hidden = pane.dataset.marketPane !== action;
  }
  if (action === 'list-sale') void loadListingInventory().catch(error => {
    $('listing-inventory').replaceChildren(node('p', error.message));
  });
}
function showMarketPage() {
  const current = marketPages.find(page => '#' + page.id === location.hash) ?? $(materialFilter ? 'materials' : 'artifacts');
  for (const page of marketPages) page.hidden = page !== current;
  for (const link of marketLinks) {
    if (link.hash === '#' + current.id) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}
for (const page of marketPages) {
  const buttons = page.querySelectorAll('[data-market-action]');
  for (const button of buttons) button.onclick = () => showMarketAction(page, button.dataset.marketAction);
  showMarketAction(page, buttons[0].dataset.marketAction);
}
window.addEventListener('hashchange', showMarketPage);
showMarketPage();

async function api(path, body) {
  const response = await fetch('/api/' + path, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = feedback[result.error] ?? (response.status === 404 ? feedback.NOT_FOUND
      : result.error ?? 'Request failed (' + response.status + ').');
    throw new Error(message);
  }
  return result;
}

const economy = (path, body) => api('economy/' + path, body);
const announce = message => { $('status').textContent = message; };
const query = (path, values) => path + '?' + new URLSearchParams(values);
const node = (tag, text) => Object.assign(document.createElement(tag), { textContent: text });
const fill = (id, entries, fallback) => $(id).replaceChildren(...(entries.length ? entries : [node('p', fallback)]));

function actionButton(text, action) {
  const button = node('button', text);
  button.type = 'button';
  listen(button, 'click', action);
  return button;
}

function listen(element, event, task) {
  element.addEventListener(event, async e => {
    if (event === 'submit') e.preventDefault();
    if (busy) return;
    busy = true;
    const trigger = event === 'submit' ? e.submitter : element;
    if (trigger) trigger.disabled = true;
    announce('');
    try { await task(e); }
    catch (error) { announce(error.message ?? 'The operation failed.'); }
    finally {
      if (trigger) trigger.disabled = false;
      busy = false;
    }
  });
}

const on = (id, task) => listen($(id), 'click', task);
const submit = (id, task) => listen($(id), 'submit', e => task(
  Object.fromEntries([...new FormData(e.currentTarget)].map(([key, value]) => [key, value.trim()]))));
const operationId = () => crypto.randomUUID();

function toAtomic(value, decimals, currency) {
  const parts = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!parts || value.length > 64 || (parts[2]?.length ?? 0) > decimals) {
    throw new Error('Enter a valid ' + currency + ' amount with up to ' + decimals + ' decimal places.');
  }
  const amount = BigInt(parts[1] + (parts[2] ?? '').padEnd(decimals, '0'));
  if (amount <= 0n || amount >= (1n << 128n)) throw new Error('The ' + currency + ' amount is out of range.');
  return String(amount);
}

function formatAmount(value, decimals, currency) {
  const digits = BigInt(value ?? 0).toString().padStart(decimals + 1, '0');
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return digits.slice(0, -decimals) + (fraction ? '.' + fraction : '') + ' ' + currency;
}

const copper = value => formatAmount(value, 2, 'Copper');
const near = value => formatAmount(value, 24, 'testNEAR');
const timestamp = value => new Date(Number(BigInt(value) / 1000000n)).toLocaleString();

function requireAccount() {
  if (!accountId) throw new Error(feedback.LINKED_CHAIN_ACCOUNT_REQUIRED);
}

async function connect() {
  announce('Choose a NEAR testnet wallet.');
  const selected = await connector.connect();
  const challenge = await api('auth/wallet/challenge', {});
  const signed = await selected.signMessage({
    network: 'testnet',
    message: challenge.message,
    recipient: challenge.recipient,
    nonce: Uint8Array.from(atob(challenge.nonce), character => character.charCodeAt(0)),
  });
  const identity = await api('auth/wallet/verify', { ...signed, state: challenge.state });
  wallet = selected;
  await loadMarket(identity.accountId);
}

async function loadMarket(linkedAccount) {
  accountId = linkedAccount;
  $('account').textContent = accountId;
  $('connect').hidden = true;
  $('balances').textContent = 'Loading Copper balances…';
  if (!$('listing-inventory').closest('[data-market-pane]').hidden) {
    void loadListingInventory().catch(error => {
      $('listing-inventory').replaceChildren(node('p', error.message));
    });
  }
  const updates = [loadBalances(), recoverOrders().then(loadOrders), loadSales(), loadCredit(), loadProfession(), loadCheckout()];
  if (!$('charter').hidden) updates.push(loadCharters());
  const results = await Promise.allSettled(updates);
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) {
    if (results[0].status === 'rejected') $('balances').textContent = 'Copper balances are currently unavailable.';
    announce(failures[0].reason.message);
  }
}

async function loadBalances() {
  const { allocation, wallet: walletBalance } = await economy('balances');
  $('balances').textContent = 'Available ' + copper(allocation.value.available)
    + ' · Reserved ' + copper(allocation.value.reserved) + ' · Wallet ' + copper(walletBalance.value);
}

async function transact(path, input, title, summary, { reconcile, refresh = [], expectedDeposit } = {}) {
  requireAccount();
  const transaction = await economy(path, input);
  if (transaction.network !== 'testnet' || transaction.actions?.length !== 1 ||
      transaction.actions[0]?.type !== 'FunctionCall') throw new Error('The server returned an unexpected transaction.');
  if (expectedDeposit !== undefined && transaction.actions[0].params.deposit !== expectedDeposit) {
    throw new Error('The price changed. Refresh the listing to see the new price.');
  }
  announce(title + ' � ' + summary + ' Approve in your wallet.');
  if (!wallet) {
    const selected = await connector.connect();
    const accounts = await selected.getAccounts({ network: 'testnet' });
    if (!accounts.some(account => account.accountId === accountId)) throw new Error('Select the wallet for ' + accountId + '.');
    wallet = selected;
  }
  const outcome = await wallet.signAndSendTransaction({ ...transaction, signerId: accountId });
  const hash = outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id;
  if (outcome?.status?.Failure || outcome?.receipts_outcome?.some(entry => entry.outcome?.status?.Failure)) {
    throw new Error('The transaction failed on chain.' + (hash ? ' Transaction ' + hash : ''));
  }
  if (!hash) {
    announce('The wallet did not return a transaction hash. Check wallet activity before retrying.');
    return;
  }
  const success = Object.hasOwn(outcome?.status ?? {}, 'SuccessValue');
  if (reconcile) {
    try { await reconcile(hash); }
    catch (error) {
      announce('Transaction ' + hash + ' · Verification pending. ' + error.message);
      return;
    }
  }
  const final = Boolean(reconcile) || (success && outcome.final_execution_status === 'FINAL');
  const message = (final ? 'Finalized transaction ' : 'Submitted transaction ') + hash;
  const results = await Promise.allSettled(refresh.map(load => load()));
  announce(message + (results.some(result => result.status === 'rejected') ? ' · Some market data could not refresh.' : ''));
}

async function loadCheckout() {
  const { methods, intents } = await economy('checkout-methods');
  $('checkout-methods').textContent = methods.includes('near-wallet') ? 'Pay with a NEAR testnet wallet.' : '';
  if (intents?.preview?.dryRun) {
    $('checkout-methods').textContent += ' Tidepool offers a separate practice quote using test tokens.';
    $('intents-preview').hidden = false;
  }
}
on('intents-preview', async () => {
  $('intents-quote').textContent = '';
  const quote = await economy('intents-preview');
  if (quote.provider !== 'tidepool' || !quote.dryRun) throw new Error('Unexpected testnet preview.');
  const format = asset => formatAmount(asset.amountAtomic, asset.decimals, asset.symbol);
  $('intents-quote').textContent = format(quote.origin) + ' → ' + format(quote.destination) +
    ' · Tidepool testnet estimate. No funds move.';
});

async function loadOrders() {
  const { orders } = await economy('orders');
  const visible = materialFilter ? orders.filter(({ value }) => value.token_id === materialFilter && value.side === materialSide) : orders;
  fill('orders', visible.map(({ owner, orderId, value }) => {
    const article = node('article', '');
    article.append(node('h3', value.token_id + ' · ' + value.side),
      node('p', value.remaining + ' remaining · ' + copper(value.price) + ' per unit'),
      node('p', owner + ' · Expires ' + timestamp(value.expires_at_ns)));
    if (owner === accountId) {
      article.append(actionButton('Cancel order', () => transact('prepare-cancel', { orderId },
        'Cancel material order', value.side + ' ' + value.token_id, { refresh: [loadOrders, loadBalances] })));
    } else {
      const form = node('form', '');
      form.className = 'fields';
      const label = node('label', 'Quantity to fill');
      const quantity = document.createElement('input');
      quantity.required = true;
      quantity.pattern = '[1-9][0-9]{0,37}';
      quantity.inputMode = 'numeric';
      quantity.value = '1';
      label.append(quantity);
      form.append(label, node('button', 'Fill order'));
      listen(form, 'submit', () => {
        if (BigInt(quantity.value) > BigInt(value.remaining)) throw new Error('Enter a quantity within the order’s remaining stock.');
        const input = { owner, orderId, quantity: quantity.value, expectedVersion: value.version };
        const gross = BigInt(quantity.value) * BigInt(value.price);
        const fee = (gross * 3n + 99n) / 100n;
        if (fee >= gross) throw new Error('This fill is below the minimum after fees.');
        return transact('prepare-fill', input, 'Fill material order', quantity.value + ' × ' + value.token_id +
          ' · Gross ' + copper(gross) + ' · Fee ' + copper(fee) + ' · Seller receives ' + copper(gross - fee), {
          reconcile: transactionHash => economy('confirm-fill', { ...input, transactionHash }),
          refresh: [loadOrders, loadBalances],
        });
      });
      article.append(form);
    }
    return article;
  }), materialFilter ? 'No open ' + materialSide.toLowerCase() + ' orders for ' + materialFilter + '.' : 'No published material orders are open.');
  if (materialFilter) {
    const all = node('a', 'Show all material orders');
    all.href = './economy.html#materials';
    $('orders').append(all);
  }
}

async function loadCredit() {
  const { available, pending } = await economy('nft-sale-credit');
  $('sale-credit').textContent = 'Sale credit ' + near(available) + (pending !== null ? ' · Withdrawal pending' : '');
  $('withdraw-credit').hidden = !(BigInt(available) > 0n && pending === null);
}

function nftSale(input, title, summary, expectedDeposit) {
  return transact('prepare-nft-sale', input, title, summary, {
    reconcile: transactionHash => economy('nft-sales/confirm', {
      transactionHash, tokenId: input.tokenId, action: input.action,
    }),
    refresh: [loadSales, loadCredit], expectedDeposit,
  });
}

async function loadSales(append = false) {
  if (append && salesCursor === null) return;
  const cursor = append ? salesCursor : '0';
  const result = await economy(query('nft-sales', { cursor }));
  const entries = result.listings.map(({ token, sale }) => {
    const tokenId = token.token_id;
    const article = node('article', '');
    article.className = 'artifact-card';
    article.dataset.price = sale.price;
    const title = token.metadata?.title || tokenId;
    article.dataset.search = (title + ' ' + tokenId).toLowerCase();
    const art = node('img', '');
    const fallback = 'combat-assets/talismans-v3/gate.png';
    art.alt = '';
    art.loading = 'lazy';
    art.referrerPolicy = 'no-referrer';
    art.src = fallback;
    try {
      const media = new URL(token.metadata?.media);
      if (media.protocol === 'https:' && !media.username && !media.password) art.src = media.href;
    } catch {}
    art.onerror = () => { art.onerror = null; art.src = fallback; };
    article.append(art, node('h3', title), node('strong', near(sale.price)));
    const own = sale.seller === accountId;
    article.append(actionButton(own ? 'Cancel Listing' : 'Buy', () => nftSale(
      { tokenId, action: own ? 'cancel' : 'buy', expectedEpoch: sale.epoch },
      own ? 'Cancel artifact listing' : 'Buy artifact',
      tokenId + (own ? '' : ' from ' + sale.seller + ' for ' + near(sale.price)), own ? undefined : sale.price,
    )));
    return article;
  });
  salesCursor = result.nextCursor;
  if (append && entries.length) $('sales').querySelector('p[data-empty]')?.remove();
  if (append) $('sales').append(...entries);
  else if (entries.length) $('sales').replaceChildren(...entries);
  else {
    const empty = node('p', 'No listings on this page. Load more if additional artifacts are available.');
    empty.dataset.empty = 'true';
    $('sales').replaceChildren(empty);
  }
  const empty = $('sales').querySelector('p[data-empty]');
  if (empty && salesCursor === null) empty.textContent = 'No artifact listings are open.';
  $('more-sales').hidden = salesCursor === null;
  filterArtifactCards();
}
function filterArtifactCards() {
  const search = $('artifact-search').value.trim().toLowerCase();
  const sort = $('artifact-price').value;
  const cards = [...$('sales').querySelectorAll('.artifact-card')];
  let shown = 0;
  for (const card of cards) {
    card.hidden = !card.dataset.search.includes(search);
    if (!card.hidden) shown++;
  }
  const ordered = [...cards].sort((a, b) => {
    const price = BigInt(a.dataset.price) - BigInt(b.dataset.price);
    return sort ? Math.sign(Number(price)) * (sort === 'low' ? 1 : -1) : 0;
  });
  ordered.forEach((card, index) => { card.style.order = sort ? index : ''; });
  $('artifact-no-match').hidden = !cards.length || Boolean(shown);
}
$('artifact-search').addEventListener('input', filterArtifactCards);
$('artifact-price').addEventListener('change', filterArtifactCards);

async function loadRental(tokenId) {
  const { value } = await economy(query('nft-rental', { tokenId }));
  if (!value) {
    fill('rental', [], 'No rental offer for this token.');
    return;
  }
  const article = node('article', '');
  article.append(node('h3', tokenId),
    node('p', near(value.price) + ' · ' + value.duration_hours + ' hours · Owner ' + value.owner));
  if (value.renter) {
    article.append(node('p', 'Renter ' + value.renter + ' · Expires ' + timestamp(value.expires_at_ns)));
  } else {
    const own = value.owner === accountId;
    article.append(actionButton(own ? 'Cancel rental' : 'Rent', () => transact('prepare-nft-rental', {
      tokenId, action: own ? 'cancel' : 'accept', priceYocto: value.price, expectedEpoch: value.epoch,
    }, own ? 'Cancel rental offer' : 'Rent relic',
    tokenId + (own ? '' : ' · ' + near(value.price) + ' for ' + value.duration_hours + ' hours'),
    { refresh: [() => loadRental(tokenId)], expectedDeposit: own ? undefined : value.price })));
  }
  fill('rental', [article]);
}

async function loadGuild(guildId, paymentId = '') {
  const { value } = await economy(query('guild-treasury', { guildId }));
  if (!value) {
    fill('guild-summary', [], 'No treasury found for this guild.');
    return;
  }
  const article = node('article', '');
  article.append(node('h3', guildId), node('p', 'Available ' + copper(value.available) + ' · Reserved ' + copper(value.reserved)),
    node('p', 'Members ' + value.members.join(', ')));
  if (paymentId) {
    const { value: payment } = await economy(query('guild-payment', { guildId, paymentId }));
    article.append(node('h3', 'Payment ' + paymentId));
    if (payment) article.append(
      node('p', copper(payment.amount) + ' to ' + payment.recipient + ' · ' + payment.status),
      node('p', 'Approvals ' + payment.approvals.length + ' · Expires ' + timestamp(payment.expires_at_ns)),
    );
    else article.append(node('p', 'No payment found for this ID.'));
  }
  fill('guild-summary', [article]);
}

function guildFields() {
  const form = $('guild-action');
  const action = form.elements.action.value;
  for (const label of form.querySelectorAll('[data-guild-for]')) {
    const visible = label.dataset.guildFor.split(' ').includes(action);
    label.hidden = !visible;
    label.querySelector('input, select').disabled = !visible;
  }
}

on('connect', connect);
on('refresh-orders', async () => { await Promise.all([recoverOrders().then(loadOrders), loadBalances()]); });
on('refresh-sales', async () => { await Promise.all([loadSales(), loadCredit()]); });
on('more-sales', () => loadSales(true));
on('withdraw-credit', () => transact('prepare-nft-sale-withdrawal', {}, 'Withdraw sale credit',
  $('sale-credit').textContent + ' to your testnet wallet.', { refresh: [loadCredit] }));
function pendingOrders() {
  const key = 'veilbound-pending-market-orders:' + accountId;
  let hashes = [];
  try { hashes = JSON.parse(localStorage.getItem(key) ?? '[]'); } catch {}
  const save = () => localStorage.setItem(key, JSON.stringify(hashes));
  return {
    hashes,
    add(hash) { if (!hashes.includes(hash)) { hashes.push(hash); save(); } },
    remove(hash) { hashes = hashes.filter(entry => entry !== hash); save(); },
  };
}
async function publishSignedOrder(hash) {
  const orders = pendingOrders();
  orders.add(hash);
  for (const ms of [0, 900, 1800, 3000, 4000]) {
    if (ms) await new Promise(resolve => setTimeout(resolve, ms));
    try {
      await economy('orders/publish', { transactionHash: hash });
      orders.remove(hash);
      return;
    } catch { /* A submitted order may take several blocks to finalize. */ }
  }
  throw new Error('The game will retry publishing when you reopen the market.');
}
async function recoverOrders() {
  const orders = pendingOrders();
  await Promise.allSettled(orders.hashes.map(async hash => {
    await economy('orders/publish', { transactionHash: hash });
    pendingOrders().remove(hash);
  }));
}
submit('place-order', ({ side, tokenId, quantity, price, hours }) => {
  const priceAtomic = toAtomic(price, 2, 'Copper');
  return transact('prepare-order', {
    orderId: operationId(), side, tokenId, quantity, price: priceAtomic, expiresAtMs: Date.now() + Number(hours) * 3600000,
  }, 'Place Copper order', side + ' ' + quantity + ' × ' + tokenId + ' · ' + copper(priceAtomic) + ' per unit · ' + hours + ' hours', {
    reconcile: publishSignedOrder,
    refresh: [loadOrders, loadBalances],
  });
});
const charterPicker = $('charter-picker');
const charterItems = new Map([
  ['salt', 'Salt'], ['resin', 'Resin'], ['iron', 'Iron'], ['thread', 'Thread'],
  ['ash', 'Ash'], ['salve', 'Reed Salve'], ['ward', 'Ward'],
  ['relic-inlay', 'Relic Inlay'], ['binding', 'Binding'],
]);
$('charter-item-catalog').replaceChildren(...[...charterItems].map(([id, title]) => new Option(title, id)));

let charterRequest = 0;
let charterSnapshot = null;

function selectedCharter() {
  const charterId = charterPicker.value;
  if (!charterSnapshot || charterSnapshot.id !== charterId) throw new Error('Refresh your Shop Charter before trading.');
  return { charterId, expectedEpoch: charterSnapshot.epoch };
}

async function loadCharters() {
  requireAccount();
  const status = $('charter-stock-status');
  const previous = charterPicker.value;
  ++charterRequest;
  charterSnapshot = null;
  charterPicker.closest('.charter-selector').hidden = true;
  $('charter-actions').hidden = $('charter-forms').hidden = true;
  $('charter-stock').replaceChildren();
  status.textContent = 'Loading your Shop Charters…';
  const owned = [];
  let cursor = '0';
  try {
    for (let page = 0; cursor !== null && page < 20; page++) {
      const result = await economy(query('listing-inventory', { cursor }));
      owned.push(...result.items.filter(item => item.kind === 'SHOP_CHARTER'));
      cursor = result.nextCursor;
    }
  } catch (error) {
    status.textContent = 'Shop Charters are temporarily unavailable.';
    throw error;
  }
  const ready = owned.filter(item => !item.sale);
  charterPicker.replaceChildren(...owned.map(({ token, sale }) => {
    const title = token.metadata?.title || token.token_id;
    const item = new Option(title + (sale ? ' · Listed for sale' : ''), token.token_id);
    item.disabled = Boolean(sale);
    return item;
  }));
  const listed = owned.length - ready.length;
  status.textContent = owned.length
    ? ready.length + ' ready' + (listed ? ' · ' + listed + ' listed for sale' : '')
    : 'You do not own a ready Shop Charter.';
  charterPicker.closest('.charter-selector').hidden = !owned.length;
  charterPicker.disabled = !ready.length;
  if (!ready.length) return;
  charterPicker.value = ready.find(({ token }) => token.token_id === previous)?.token.token_id ?? ready[0].token.token_id;
  await showCharterStock();
}

function charterMetric(label, value) {
  const wrapper = node('div', '');
  wrapper.append(node('dt', label), node('dd', value));
  return wrapper;
}

async function showCharterStock() {
  const request = ++charterRequest;
  const charterId = charterPicker.value;
  const panel = $('charter-stock');
  charterSnapshot = null;
  $('charter-actions').hidden = $('charter-forms').hidden = true;
  panel.replaceChildren();
  if (!charterId) return;
  panel.append(node('p', 'Reading finalized shop stock…'));
  try {
    const snapshot = await economy(query('charter-stock', { charterId }));
    if (request !== charterRequest) return;
    const metrics = node('dl', '');
    metrics.className = 'charter-metrics';
    metrics.append(
      charterMetric('Available', copper(snapshot.copper.available)),
      charterMetric('Reserved', copper(snapshot.copper.reserved)),
      charterMetric('Open orders', String(snapshot.openOrders)),
    );
    const stocked = snapshot.stock.filter(item => BigInt(item.available) || BigInt(item.reserved));
    panel.replaceChildren(metrics);
    if (!stocked.length) panel.append(node('p', 'No stock in this vault.'));
    else {
      const stock = node('ul', '');
      stock.className = 'charter-stock-list';
      for (const item of stocked) {
        const row = node('li', '');
        const name = charterItems.get(item.id) ?? item.id;
        row.append(node('strong', name), node('span', item.available + ' available · ' + item.reserved + ' reserved'));
        if (BigInt(item.available)) {
          const sell = node('button', 'Sell stock');
          sell.type = 'button';
          sell.onclick = () => {
            const form = $('charter-place');
            form.elements.side.value = 'sell';
            form.elements.tokenId.value = item.id;
            form.elements.quantity.value = '1';
            showMarketAction($('charter'), 'charter-place');
            form.elements.price.focus();
          };
          row.append(sell);
        }
        stock.append(row);
      }
      panel.append(stock);
    }
    charterSnapshot = { id: charterId, epoch: String(snapshot.epoch) };
    $('charter-actions').hidden = $('charter-forms').hidden = false;
  } catch (error) {
    if (request === charterRequest) panel.replaceChildren(node('p', error.message));
  }
}
charterPicker.addEventListener('change', showCharterStock);
on('charter-refresh', loadCharters);

submit('charter-fund', ({ copper: amount, tokenId, quantity }) => {
  const charter = selectedCharter();
  const funding = /^0+(?:\.0{1,2})?$/.test(amount) ? '0' : toAtomic(amount, 2, 'Copper');
  if (Boolean(tokenId) !== Boolean(quantity)) throw new Error('Enter both an item and its quantity.');
  const items = tokenId ? [{ tokenId, amount: quantity }] : [];
  if (funding === '0' && !items.length) throw new Error('Enter Copper or an item to fund the shop.');
  return transact('prepare-charter-order', { action: 'fund', ...charter, copper: funding, items },
    'Fund shop vault', charter.charterId + ' / ' + copper(funding) + (tokenId ? ' / ' + quantity + ' × ' + tokenId : ''),
    { refresh: [loadBalances, showCharterStock] });
});
submit('charter-place', ({ side, tokenId, quantity, price }) => {
  const charter = selectedCharter();
  const priceAtomic = toAtomic(price, 2, 'Copper');
  const orderId = operationId();
  return transact('prepare-charter-order', {
    action: 'place', ...charter, side, tokenId, quantity, price: priceAtomic,
    orderId, expiresAtMs: Date.now() + 3600000,
  }, 'Place shop order', charter.charterId + ' / ' + side + ' ' + quantity + ' × ' + tokenId +
    ' / ' + copper(priceAtomic) + ' per unit / order ' + orderId, {
    reconcile: publishSignedOrder, refresh: [loadOrders, loadBalances, showCharterStock],
  });
});
submit('charter-cancel', ({ orderId }) => {
  const charter = selectedCharter();
  return transact('prepare-charter-order', { action: 'cancel', ...charter, orderId },
    'Cancel shop order', charter.charterId + ' / order ' + orderId,
    { refresh: [loadOrders, loadBalances, showCharterStock] });
});

const specialties = { apothecary: 'Apothecary', relicsmith: 'Relicsmith', binder: 'Binder' };
const recipeLabels = {
  'apothecary-ward-v1': 'Ward',
  'relicsmith-inlay-v1': 'Relic Inlay',
  'binder-binding-v1': 'Binding',
};
const recipes = craftingCatalog();
function recipeSummary(recipe) {
  const inputs = Object.entries(recipe.inputs).map(([item, count]) => count + ' × ' + item);
  return inputs.join(' + ') + ' + ' + copper(recipe.copperAtomic);
}
for (const id of ['craft-item', 'craft-commission']) {
  const select = $(id).elements.recipeId;
  for (const recipe of recipes) {
    const option = node('option', recipeLabels[recipe.id] + ' / ' + recipeSummary(recipe));
    option.value = recipe.id;
    select.append(option);
  }
}
const craftRecipe = $('craft-item').elements.recipeId;
const craftMaterials = $('craft-materials');
function showCraftMaterials() {
  const recipe = recipes.find(entry => entry.id === craftRecipe.value);
  craftMaterials.replaceChildren(...Object.keys(recipe?.inputs ?? {}).map(item => {
    const link = node('a', 'Find ' + item);
    link.href = './economy.html?' + new URLSearchParams({ material: item, side: 'sell' }) + '#materials';
    const row = node('li', '');
    row.append(link);
    return row;
  }));
}
craftRecipe.addEventListener('change', showCraftMaterials);
showCraftMaterials();
function renderProfession({ region, active, unlocked, quests = [] }) {
  $('profession-status').textContent = 'Highest checkpoint ' + region + ' / Active specialty ' +
    (specialties[active] ?? 'None');
  $('profession-quests').replaceChildren(...quests.map(quest => node('li', [
    specialties[quest.specialty], quest.title, quest.objective, 'Checkpoint ' + quest.checkpoint,
    quest.completed ? 'Complete' : quest.objectiveMet ? 'Objective complete' : 'In progress',
  ].join(' · '))));
  const select = $('profession-select').elements.specialty;
  select.replaceChildren(...unlocked.map(specialty => Object.assign(node('option', specialties[specialty]), { value: specialty })));
  if (active) select.value = active;
  $('profession-select').querySelector('button').disabled = unlocked.length === 0;
  select.disabled = unlocked.length === 0;
}
async function loadProfession() {
  renderProfession(await api('professions'));
}
on('profession-refresh', loadProfession);
submit('profession-record', async ({ runId }) => {
  renderProfession(await api('professions/record', { runId }));
  announce('Expedition progress recorded.');
});
submit('profession-select', async ({ specialty }) => {
  renderProfession(await api('professions/select', { specialty }));
  announce('Specialty selected.');
});
submit('craft-item', async ({ recipeId, workshop }) => {
  const quote = await api('economy/craft-quote?recipeId=' + encodeURIComponent(recipeId));
  const inputs = quote.inputs.map(({ itemId, required, available }) =>
    required + ' × ' + itemId + ' (' + available + ' available)');
  const fee = BigInt(quote.copperAtomic);
  const copper = (fee / 100n) + '.' + String(fee % 100n).padStart(2, '0') + ' Copper';
  if (!quote.affordable) throw new Error('Not enough materials or Copper. ' + [...inputs, copper].join(' · '));
  return transact('prepare-craft', { recipeId, workshop, operationId: operationId() },
    'Craft ' + recipeLabels[recipeId], [...inputs, copper, 'Makes ' + quote.output.quantity + ' × ' + quote.output.itemId].join(' · '),
    { refresh: [loadBalances] });
});
submit('craft-commission', ({ recipeId, worker, wage, hours }) => {
  const recipe = recipes.find(row => row.id === recipeId);
  const wageAtomic = toAtomic(wage, 2, 'Copper');
  const orderId = operationId();
  return transact('prepare-craft-order', {
    recipeId, worker, orderId, wageAtomic, deadlineMs: Date.now() + Number(hours) * 3600000,
  }, 'Commission ' + recipeLabels[recipeId], recipeSummary(recipe) + ' + ' + copper(wageAtomic) +
    ' wage / Crafter ' + worker + ' / Order ' + orderId, { refresh: [loadBalances] });
});
submit('craft-action', ({ buyer, orderId, action }) =>
  transact('prepare-craft-order-action', { buyer, orderId, action },
    action === 'fulfill' ? 'Fulfill commission' : 'Cancel commission', buyer + ' / Order ' + orderId,
    { refresh: [loadBalances] }));

let listingCursor = null;
let listingToken;
async function loadListingInventory(append = false) {
  const grid = $('listing-inventory');
  if (!append) {
    listingCursor = null;
    $('more-owned').hidden = true;
    grid.replaceChildren(node('p', accountId ? 'Loading your artifacts…' : 'Connect your NEAR wallet to see your artifacts.'));
  }
  if (!accountId || (append && listingCursor === null)) return;
  const { items, nextCursor } = await economy(query('listing-inventory', { cursor: append ? listingCursor : '0' }));
  const cards = items.map(({ token, locked, sale }) => {
    const card = node('article', '');
    card.className = 'artifact-card';
    const title = token.metadata?.title || token.token_id;
    const image = node('img', '');
    image.alt = '';
    image.referrerPolicy = 'no-referrer';
    const fallback = 'combat-assets/talismans-v3/gate.png';
    image.src = fallback;
    try {
      const media = new URL(token.metadata?.media);
      if (media.protocol === 'https:' && !media.username && !media.password) image.src = media.href;
    } catch {}
    image.onerror = () => { image.onerror = null; image.src = fallback; };
    card.append(image, node('h3', title));
    if (sale) card.append(node('strong', near(sale.price)), actionButton('Cancel Listing', async () => {
      await nftSale({ tokenId: token.token_id, action: 'cancel' }, 'Cancel listing', title);
      await loadListingInventory();
    }));
    else if (locked) card.append(node('p', 'Reserved'));
    else {
      const list = node('button', 'List for Sale');
      list.type = 'button';
      list.onclick = () => {
        listingToken = token;
        $('listing-item').replaceChildren(image.cloneNode(), node('strong', title));
        $('list-sale').reset();
        $('listing-proceeds').textContent = '';
        $('listing-dialog').showModal();
      };
      card.append(list);
    }
    return card;
  });
  if (!append) grid.replaceChildren();
  if (cards.length) grid.querySelector('p[data-inventory-empty]')?.remove();
  grid.append(...cards);
  if (!grid.childElementCount) {
    const empty = node('p', 'No artifacts available on this page.');
    empty.dataset.inventoryEmpty = '';
    grid.append(empty);
  }
  listingCursor = nextCursor;
  $('more-owned').hidden = nextCursor == null;
}
on('more-owned', () => loadListingInventory(true));
$('listing-back').onclick = () => $('listing-dialog').close();
$('list-sale').elements.price.oninput = event => {
  try {
    const amount = BigInt(toAtomic(event.target.value, 24, 'testNEAR'));
    const fee = (amount * 250n + 9999n) / 10000n;
    $('listing-proceeds').textContent = 'Market fee ' + near(fee) + ' · You receive ' + near(amount - fee);
  } catch { $('listing-proceeds').textContent = ''; }
};
submit('list-sale', async ({ price }) => {
  const priceYocto = toAtomic(price, 24, 'testNEAR');
  if (BigInt(priceYocto) < 100n) throw new Error('Enter a higher listing price.');
  const token = listingToken;
  $('listing-dialog').close();
  await nftSale({ tokenId: token.token_id, action: 'list', priceYocto }, 'List artifact',
    (token.metadata?.title || token.token_id) + ' · ' + near(priceYocto) + ' · Until sold or cancelled');
  await loadListingInventory();
});
submit('find-rental', ({ tokenId }) => loadRental(tokenId));
submit('list-rental', ({ tokenId, price, durationHours }) => {
  const priceYocto = toAtomic(price, 24, 'testNEAR');
  return transact('prepare-nft-rental', { tokenId, action: 'list', priceYocto, durationHours: Number(durationHours) },
    'Offer relic rental', tokenId + ' · ' + near(priceYocto) + ' for ' + durationHours + ' hours',
    { refresh: [() => loadRental(tokenId)] });
});
submit('find-guild', ({ guildId, paymentId }) => loadGuild(guildId, paymentId));
submit('guild-action', ({ action, guildId, members, amount, paymentId, recipient, hours }) => {
  const input = { action, guildId };
  if (members) input.members = members.split(',').map(member => member.trim());
  if (amount) input.amount = toAtomic(amount, 2, 'Copper');
  if (paymentId) input.paymentId = paymentId;
  if (recipient) input.recipient = recipient;
  if (hours) input.expiresAtMs = Date.now() + Number(hours) * 3600000;
  if (action === 'contribute') input.operationId = operationId();
  const summary = [guildId, input.members?.join(', '), paymentId, recipient,
    input.amount && copper(input.amount), hours && 'Expires after ' + hours + ' hours'].filter(Boolean).join(' · ');
  const title = $('guild-action').elements.action.selectedOptions[0].textContent;
  return transact('prepare-guild-action', input, title, summary,
    { refresh: [() => loadGuild(guildId, paymentId), loadBalances] });
});
$('guild-action').elements.action.addEventListener('change', guildFields);
guildFields();
void api('session').then(session => {
  if (session.accountId && !accountId) return loadMarket(session.accountId);
}).catch(() => {});
