import { randomUUID } from 'node:crypto';
import { validateProposal } from './policy.mjs';

const atomic = value => {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,38})$/.test(value) || BigInt(value) >= 1n << 128n) throw new Error('invalid_shop_amount');
  return BigInt(value);
};
const fee = value => (value * 3n + 99n) / 100n;
const count = value => Number.isSafeInteger(value) && value >= 0;
const account = /^(?:[a-z0-9]+(?:[-_.][a-z0-9]+)*\.testnet|[a-f0-9]{64})$/;

export function stockPrices({ stock, target, anchorAtomic, spreadBps, stockImpactBps }) {
  if (!count(stock) || !count(target) || !target || !count(spreadBps) || spreadBps < 100 || spreadBps > 5000 ||
      !count(stockImpactBps) || stockImpactBps > 5000) throw new Error('invalid_shop_price_policy');
  const anchor = atomic(anchorAtomic);
  if (anchor < 4n) throw new Error('shop_price_below_fee_floor');
  const imbalance = BigInt(Math.max(-target, Math.min(target, target - stock)));
  const adjustment = imbalance * BigInt(stockImpactBps) / BigInt(target);
  const mid = anchor * (10000n + adjustment) / 10000n;
  const bid = mid * (10000n - BigInt(spreadBps)) / 10000n;
  const ask = (mid * (10000n + BigInt(spreadBps)) + 9999n) / 10000n;
  if (bid <= 1n || ask <= bid || ask >= 1n << 128n) throw new Error('invalid_shop_price_policy');
  return { bidAtomic: bid.toString(), askAtomic: ask.toString(),
    feeBps: 300, roundTripLossAtomic: (ask - (bid - fee(bid))).toString() };
}

/** Quotes only prepare orders. Core reserves capital and stock when the user signs. */
export function createShopQuotes({ policy, pricing, readSnapshot, core, now = Date.now, ttlMs = 30_000 }) {
  policy = structuredClone(policy);
  pricing = structuredClone(pricing);
  if (!count(ttlMs) || ttlMs < 1000 || ttlMs > 60_000 ||
      typeof readSnapshot !== 'function' || typeof core?.prepareMarketOrder !== 'function' ||
      !Array.isArray(policy.itemIds) || policy.itemIds.length > 50) throw new Error('invalid_shop_configuration');
  const quotes = new Map();
  const purge = timestamp => {
    for (const [id, quote] of quotes) if (quote.expiresAt <= timestamp) quotes.delete(id);
  };
  const snapshot = async accountId => {
    if (typeof accountId !== 'string' || !account.test(accountId)) throw new Error('invalid_shop_account');
    const state = await readSnapshot(accountId, policy.itemIds);
    if (state.accountId !== accountId || !state.blockHash) throw new Error('shop_snapshot_unverified');
    return state;
  };
  return {
    async quote(accountId) {
      const state = await snapshot(accountId);
      const timestamp = now();
      purge(timestamp);
      if (quotes.size + policy.itemIds.length * 2 > 10000) throw new Error('shop_quote_capacity');
      const available = atomic(state.availableAtomic);
      let remainingBudget = atomic(policy.budgetRemainingAtomic);
      let cash = available;
      const result = [];
      for (const itemId of policy.itemIds) {
        const stock = state.stock[itemId] ?? 0;
        const target = policy.targetStock[itemId];
        const prices = stockPrices({ stock, target, ...pricing[itemId] });
        const expiresAt = Math.min(timestamp + ttlMs, policy.expiresAt);
        for (const side of ['buy', 'sell']) {
          if (!policy.methods.includes(side)) continue;
          const priceAtomic = side === 'buy' ? prices.bidAtomic : prices.askAtomic;
          const price = atomic(priceAtomic);
          let quantity = side === 'buy' ? Math.max(0, target - stock) : stock;
          quantity = Math.min(quantity, policy.maxQuantity);
          if (side === 'buy') quantity = Number([BigInt(quantity), cash / price, remainingBudget / price].reduce((a, b) => a < b ? a : b));
          if (!quantity) continue;
          const proposal = { method: side, itemId, quantity, unitPriceAtomic: priceAtomic, quoteExpiresAt: expiresAt };
          const action = validateProposal({ proposal, policy: { ...policy, budgetRemainingAtomic: side === 'buy' ? remainingBudget.toString() : policy.budgetRemainingAtomic },
            snapshot: { ...state, availableAtomic: cash.toString() }, now: timestamp });
          const quote = { id: randomUUID(), accountId, itemId, side, priceAtomic,
            maxQuantity: action.quantity, expiresAt, epoch: state.epoch, blockHash: state.blockHash,
            feeBps: 300, roundTripLossAtomic: prices.roundTripLossAtomic };
          quotes.set(quote.id, quote);
          result.push(quote);
          if (side === 'buy') { cash -= BigInt(action.costAtomic); remainingBudget -= BigInt(action.costAtomic); }
        }
      }
      return { planner: 'rule-based', accountId, blockHash: state.blockHash, quotes: structuredClone(result) };
    },
    async prepare(accountId, { quoteId, quantity }) {
      const quote = quotes.get(quoteId);
      if (!quote || quote.accountId !== accountId) throw new Error('quote_missing');
      if (now() >= quote.expiresAt) throw new Error('quote_expired');
      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > quote.maxQuantity) throw new Error('invalid_shop_quantity');
      const state = await snapshot(accountId);
      const current = stockPrices({ stock: state.stock[quote.itemId] ?? 0,
        target: policy.targetStock[quote.itemId], ...pricing[quote.itemId] });
      if (state.epoch !== quote.epoch || quote.priceAtomic !== (quote.side === 'buy' ? current.bidAtomic : current.askAtomic)) throw new Error('quote_changed');
      validateProposal({ proposal: { method: quote.side, itemId: quote.itemId, quantity,
        unitPriceAtomic: quote.priceAtomic, quoteExpiresAt: quote.expiresAt }, policy, snapshot: state, now: now() });
      const orderId = 'shop-' + quote.id.replaceAll('-', '');
      return {
        signerId: accountId, quoteId, snapshotBlockHash: state.blockHash, status: 'UNSIGNED',
        transaction: core.prepareMarketOrder({ orderId, side: quote.side, tokenId: quote.itemId,
          quantity: String(quantity), price: quote.priceAtomic, expiresAtMs: quote.expiresAt }),
      };
    },
  };
}

export function createShopRoutes({ service, accountForPlayer }) {
  return async ({ method, path, playerId, readBody }) => {
    if (!['/api/shop/quotes', '/api/shop/prepare-order'].includes(path)) return undefined;
    const accountId = accountForPlayer(playerId);
    if (!accountId) throw Object.assign(new Error('LINKED_CHAIN_ACCOUNT_REQUIRED'), { status: 409, code: 'LINKED_CHAIN_ACCOUNT_REQUIRED' });
    try {
      if (method === 'GET' && path === '/api/shop/quotes') return await service.quote(accountId);
      if (method !== 'POST' || path !== '/api/shop/prepare-order') return undefined;
      const body = await readBody();
      if (Object.keys(body).length !== 2 || typeof body.quoteId !== 'string' || !Number.isSafeInteger(body.quantity)) {
        throw Object.assign(new Error('INVALID_SHOP_REQUEST'), { status: 400, code: 'INVALID_SHOP_REQUEST' });
      }
      return await service.prepare(accountId, body);
    } catch (error) {
      if (error.status) throw error;
      if (['quote_missing', 'quote_expired', 'quote_changed', 'invalid_shop_quantity', 'insufficient_stock', 'insufficient_funds'].includes(error.message)) {
        throw Object.assign(error, { status: 409, code: error.message.toUpperCase() });
      }
      throw error;
    }
  };
}
