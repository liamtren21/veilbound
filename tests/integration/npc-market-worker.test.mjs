import test from 'node:test';
import assert from 'node:assert/strict';
import { openNpcMarketWorker } from '../../server/src/npc/market-worker.mjs';

function fixture() {
  const orders = new Map();
  const sends = [];
  let now = 1_800_000_000_000;
  let funds = '500';
  let stock = 0;
  let timeout = false;
  const accountId = 'npc.demo.testnet';
  const policy = { epoch: 1, expiresAt: now + 100_000, methods: ['buy'], itemIds: ['salt'],
    maxQuantity: 2, maxUnitPriceAtomic: '100', budgetRemainingAtomic: '250', targetStock: { salt: 4 } };
  const options = {
    enabled: true, accountId, coreId: 'core.demo.testnet', policy,
    pricing: { salt: { anchorAtomic: '100', spreadBps: 1500, stockImpactBps: 0 } },
    now: () => now, ttlMs: 1000,
    readSnapshot: async id => ({ accountId: id, epoch: 1, blockHash: 'snapshot', availableAtomic: funds, stock: { salt: stock } }),
    core: {
      prepareMarketOrder: ({ orderId, side, tokenId, quantity, price, expiresAtMs }) => ({
        network: 'testnet', receiverId: 'core.demo.testnet', actions: [{ type: 'FunctionCall',
          params: { methodName: 'place_market_order', args: { order_id: orderId, side: side === 'buy' ? 'Buy' : 'Sell',
            token_id: tokenId, quantity, price, expires_at_ns: String(BigInt(expiresAtMs) * 1_000_000n) },
            gas: '100000000000000', deposit: '1' } }],
      }),
      order: async (_id, operationId) => ({ value: orders.get(operationId), blockHash: 'receipt' }),
    },
    signAndSend: async ({ accountId: signerId, transaction }) => {
      assert.equal(signerId, accountId);
      const { args } = transaction.actions[0].params;
      sends.push(args);
      orders.set(args.order_id, { ...args, remaining: args.quantity, cancelled: false });
      if (timeout) throw new Error('rpc_timeout');
      return { transactionHash: 'transaction' };
    },
  };
  return { options, sends, orders, advance: () => { now += 1001; },
    fund: value => { funds = value; }, stock: value => { stock = value; }, timeout: () => { timeout = true; } };
}

test('NPC orders use real available balance, stock and configured buy side with no implicit enablement', async () => {
  const f = fixture();
  assert.throws(() => openNpcMarketWorker(':memory:', { ...f.options, enabled: false }), /npc_market_disabled/);
  const worker = openNpcMarketWorker(':memory:', f.options);
  try {
    f.fund('84');
    assert.equal((await worker.tick()).length, 0);
    f.fund('500');
    f.stock(4);
    assert.equal((await worker.tick()).length, 0);
    f.stock(0);
    const results = await worker.tick();
    assert.equal(results[0].status, 'final');
    assert.equal(results[0].receipt.blockHash, 'receipt');
    assert.deepEqual(f.sends.map(({ side, quantity, price }) => ({ side, quantity, price })),
      [{ side: 'Buy', quantity: '2', price: '85' }]);
  } finally { worker.close(); }
});

test('NPC order escrow cap and unresolved SKU survive a restart and concurrent worker ticks', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(join(tmpdir(), 'npc-market-'));
  const file = join(directory, 'jobs.sqlite');
  const f = fixture();
  f.timeout();
  let worker = openNpcMarketWorker(file, f.options);
  const competing = openNpcMarketWorker(file, f.options);
  try {
    await Promise.all([worker.tick(), competing.tick()]);
    assert.equal(f.sends.length, 1);
    worker.close();
    worker = openNpcMarketWorker(file, f.options);
    assert.equal((await worker.tick())[0].status, 'final');
    assert.equal(f.sends.length, 1);
    f.advance();
    assert.equal((await worker.tick()).length, 0);
    assert.equal(f.sends.length, 1);
  } finally {
    worker.close();
    competing.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('NPC rejects a prepared transaction whose calldata differs from the bounded proposal', async () => {
  const f = fixture();
  const prepare = f.options.core.prepareMarketOrder;
  f.options.core.prepareMarketOrder = input => {
    const transaction = prepare(input);
    transaction.actions[0].params.args.quantity = '9999';
    return transaction;
  };
  const worker = openNpcMarketWorker(':memory:', f.options);
  try {
    assert.equal((await worker.tick())[0].error, 'npc_market_transaction_mismatch');
    assert.equal(f.sends.length, 0);
  } finally { worker.close(); }
});

test('NPC releases expired order escrow and retains the campaign commitment cap', async () => {
  const f = fixture();
  const originalSign = f.options.signAndSend;
  f.options.core.prepareMarketCancel = async (_account, { orderId }) => ({
    network: 'testnet', receiverId: f.options.coreId, actions: [{ type: 'FunctionCall',
      params: { methodName: 'cancel_market_order', args: { order_id: orderId },
        gas: '100000000000000', deposit: '1' },
    }],
  });
  let cancellations = 0;
  f.options.signAndSend = async request => {
    const { methodName, args } = request.transaction.actions[0].params;
    if (methodName !== 'cancel_market_order') return originalSign(request);
    cancellations++;
    f.orders.get(args.order_id).cancelled = true;
    return { transactionHash: 'cancelled' };
  };
  const worker = openNpcMarketWorker(':memory:', f.options);
  try {
    await worker.tick();
    await worker.tick();
    assert.equal(cancellations, 0);
    f.advance();
    await worker.tick();
    await worker.tick();
    assert.equal(cancellations, 1);
    assert.equal(f.sends.length, 1);
  } finally { worker.close(); }
});


test('NPC publishes finalized orders through the market index and retries transient publication failures', async () => {
  const f = fixture();
  let attempts = 0;
  f.options.publishOrder = async (owner, hash) => {
    assert.equal(owner, f.options.accountId);
    assert.equal(hash, 'transaction');
    if (++attempts === 1) throw new Error('RPC_TEMPORARY');
  };
  const worker = openNpcMarketWorker(':memory:', f.options);
  try {
    await worker.publishOrders();
    assert.equal(attempts, 0);
    assert.equal((await worker.tick())[0].status, 'final');
    await assert.rejects(worker.publishOrders(), /RPC_TEMPORARY/);
    await worker.publishOrders();
    await worker.publishOrders();
    assert.equal(attempts, 2);
    assert.equal(f.sends.length, 1);
  } finally { worker.close(); }
});
