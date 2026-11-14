import { randomUUID } from 'node:crypto';
import { createShopSnapshotReader } from '../chain/shop-snapshot.mjs';
import { createSignedActionAdapter } from './executor.mjs';
import { planRestock } from './policy.mjs';
import { openNpcScheduler } from './scheduler.mjs';
import { stockPrices } from './shop-operator.mjs';

const accountPattern = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*\.testnet$/;
const plannedRejection = new Set(['npc_market_order_pending', 'npc_market_commitment_cap', 'npc_reserved_budget_exceeded']);

/** Run a standalone, opt-in restock worker for one dedicated funded testnet account. */
export function openNpcMarketWorker(file, {
  enabled = false, accountId, coreId, policy, pricing, core, signAndSend, now = Date.now,
  ttlMs = 300_000, readSnapshot, publishOrder,
}) {
  if (enabled !== true) throw new Error('npc_market_disabled');
  if (!accountPattern.test(accountId) || !accountPattern.test(coreId) || accountId === coreId ||
      accountId.length > 64 || coreId.length > 64 ||
      !Array.isArray(policy?.methods) || policy.methods.length !== 1 || policy.methods[0] !== 'buy' ||
      !Array.isArray(policy.itemIds) || !policy.itemIds.length || policy.itemIds.length > 10 ||
      new Set(policy.itemIds).size !== policy.itemIds.length ||
      !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 3_600_000 ||
      typeof core?.prepareMarketOrder !== 'function' || typeof core?.order !== 'function') {
    throw new Error('invalid_npc_market_configuration');
  }
  const grant = structuredClone(policy);
  const prices = structuredClone(pricing);
  const authority = { accountId, coreId, grant, prices, ttlMs };
  const snapshotReader = readSnapshot ?? createShopSnapshotReader({ coreId, epoch: grant.epoch });
  async function readContext(request) {
    if (request.accountId !== accountId) throw new Error('npc_market_account_outside_policy');
    const snapshot = await snapshotReader(accountId, grant.itemIds);
    if (!snapshot?.blockHash || snapshot.accountId !== accountId) throw new Error('shop_snapshot_unverified');
    return { policy: grant, snapshot, authority };
  }
  async function findFinal(job) {
    const { value: order, blockHash } = await core.order(accountId, job.operationId);
    if (order == null) return null;
    const action = job.action;
    if (!blockHash || order.side !== 'Buy' || order.token_id !== action.itemId ||
        order.quantity !== String(action.quantity) || order.price !== action.unitPriceAtomic ||
        order.expires_at_ns !== String(BigInt(action.quoteExpiresAt) * 1_000_000n)) {
      throw new Error('npc_market_receipt_mismatch');
    }
    return { status: 'final', receiptId: job.operationId, accountId, blockHash, transactionHash: job.transactionHash };
  }
  const adapter = createSignedActionAdapter({
    receiverId: coreId, methods: ['place_market_order'], readContext, findFinal,
    async prepare(job) {
      const { snapshot } = await readContext(job);
      const { action } = job;
      const stock = snapshot.stock[action.itemId] ?? 0;
      const target = grant.targetStock[action.itemId];
      const { bidAtomic } = stockPrices({ stock, target, ...prices[action.itemId] });
      if (snapshot.epoch !== grant.epoch || snapshot.pending || snapshot.locked || snapshot.listed ||
          action.method !== 'buy' || action.quantity > target - stock || action.unitPriceAtomic !== bidAtomic ||
          BigInt(snapshot.availableAtomic) < BigInt(action.costAtomic)) throw new Error('npc_market_stock_changed');
      const transaction = core.prepareMarketOrder({ orderId: job.operationId, side: 'buy', tokenId: action.itemId,
        quantity: String(action.quantity), price: action.unitPriceAtomic, expiresAtMs: action.quoteExpiresAt });
      const params = transaction?.actions?.[0]?.params;
      const expected = { order_id: job.operationId, side: 'Buy', token_id: action.itemId,
        quantity: String(action.quantity), price: action.unitPriceAtomic,
        expires_at_ns: String(BigInt(action.quoteExpiresAt) * 1_000_000n) };
      if (transaction?.network !== 'testnet' || params?.deposit !== '1' || !params.args ||
          Object.keys(params.args).length !== Object.keys(expected).length ||
          Object.entries(expected).some(([key, value]) => params.args[key] !== value)) {
        throw new Error('npc_market_transaction_mismatch');
      }
      return transaction;
    },
    async signAndSend(request) {
      const submitted = await signAndSend(request);
      return { status: 'pending', transactionHash: submitted?.transactionHash };
    },
  });
  if (typeof signAndSend !== 'function') throw new Error('npc_market_signer_required');
  const scheduler = openNpcScheduler(file, { adapter, now, fundedMarket: true });
  async function releaseExpiredEscrow() {
    if (typeof core.prepareMarketCancel !== 'function') return;
    for (const job of scheduler.expiredMarketOrders(accountId)) {
      const readOrder = async () => {
        const { value, blockHash } = await core.order(accountId, job.operationId);
        if (!value || !blockHash || value.side !== 'Buy' || value.token_id !== job.action.itemId ||
            value.expires_at_ns !== String(BigInt(job.action.quoteExpiresAt) * 1_000_000n)) {
          throw new Error('npc_market_receipt_mismatch');
        }
        return value;
      };
      let order = await readOrder();
      if (!order.cancelled && BigInt(order.remaining) > 0n) {
        const transaction = await core.prepareMarketCancel(accountId, { orderId: job.operationId });
        const [action] = transaction?.actions ?? [];
        if (transaction?.network !== 'testnet' || transaction.receiverId !== coreId ||
            transaction.actions.length !== 1 || action?.type !== 'FunctionCall' ||
            action.params?.methodName !== 'cancel_market_order' || action.params.deposit !== '1' ||
            action.params.gas !== '100000000000000' ||
            Object.keys(action.params.args ?? {}).length !== 1 ||
            action.params.args.order_id !== job.operationId) throw new Error('npc_market_cancel_mismatch');
        await signAndSend({ accountId, operationId: job.operationId, transaction });
        order = await readOrder();
      }
      if (order.cancelled || BigInt(order.remaining) === 0n) scheduler.markEscrowReleased(job.id);
    }
  }
  return {
    async tick() {
      await releaseExpiredEscrow();
      const results = await scheduler.tick({ limit: 10 });
      const context = await readContext({ accountId });
      const { snapshot } = context;
      const timestamp = now();
      if (grant.revoked || grant.expiresAt <= timestamp || snapshot.epoch !== grant.epoch ||
          snapshot.pending || snapshot.locked || snapshot.listed) return results;
      const quotes = Object.fromEntries(grant.itemIds.map(itemId => {
        const { bidAtomic } = stockPrices({ stock: snapshot.stock[itemId] ?? 0, target: grant.targetStock[itemId], ...prices[itemId] });
        return [itemId, { askAtomic: bidAtomic, expiresAt: Math.min(timestamp + ttlMs, grant.expiresAt) }];
      }));
      const { actions } = planRestock({ ...context, quotes, now: timestamp });
      for (const proposal of actions) {
        const id = randomUUID();
        try {
          await scheduler.enqueue({ id, accountId, proposal });
          const result = await scheduler.run(id);
          results.push(result.status === 'uncertain' && result.transactionHash ? await scheduler.run(id) : result);
        } catch (error) {
          if (!plannedRejection.has(error.message)) throw error;
        }
      }
      return results;
    },
    async publishOrders() {
      if (!publishOrder) return;
      for (const job of scheduler.publishableMarketOrders(accountId)) {
        try {
          await publishOrder(accountId, job.transactionHash);
        } catch (error) {
          if (error.message !== 'MARKET_ORDER_CLOSED') throw error;
        }
        scheduler.markMarketPublished(job.id);
      }
    },
    close: () => scheduler.close(),
  };
}
