import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCoreClient } from '../../server/src/chain/core.mjs';

test('craft order preparation binds the worker and blocks another account from cancelling', async () => {
  const client = createCoreClient({ coreId: 'core.vibebound.testnet', copperId: 'copper.vibebound.testnet',
    transport: async (_url, request) => {
      const { params } = JSON.parse(request.body);
      const value = params.method_name === 'get_recipe' ? { copper_cost: '400' }
        : { worker: 'worker.testnet', status: 'open', deadline: String(BigInt(Date.now() + 60000) * 1000000n) };
      return { ok: true, json: async () => ({ result: { result: [...Buffer.from(JSON.stringify(value))] } }) };
    } });
  const prepared = await client.prepareCraftOrder('alice.testnet', { orderId: 'craft-1', recipeId: 'apothecary-ward-v1',
    worker: 'worker.testnet', wageAtomic: '100', deadlineMs: Date.now() + 60000 });
  assert.equal(prepared.actions[0].params.args.worker, 'worker.testnet');
  await assert.rejects(client.prepareCraftOrderAction('other.testnet', { buyer: 'alice.testnet', orderId: 'craft-1', action: 'cancel' }), /unauthorized/);
  assert.equal((await client.prepareCraftOrderAction('worker.testnet', { buyer: 'alice.testnet', orderId: 'craft-1', action: 'fulfill' })).actions[0].params.methodName, 'fulfill_craft_order');
});

test('market placement encodes the contract enum and rejects overflowing escrow', () => {
  const client = createCoreClient({ coreId: 'core.vibebound.testnet', copperId: 'copper.vibebound.testnet' });
  const input = { orderId: 'order-1', side: 'sell', tokenId: 'salt', quantity: '3', price: '250',
    expiresAtMs: Date.now() + 60000 };
  const [action] = client.prepareMarketOrder(input).actions;
  assert.equal(action.params.methodName, 'place_market_order');
  assert.equal(action.params.args.side, 'Sell');
  assert.equal(action.params.args.expires_at_ns, String(BigInt(input.expiresAtMs) * 1000000n));
  assert.throws(() => client.prepareMarketOrder({ ...input, quantity: String(1n << 127n) }), /invalid_market_order/);
});
test('Core prepares an unsigned fill using final order version and rejects stale order', async () => {
  const client = createCoreClient({ coreId: 'core.demo.testnet', copperId: 'copper.demo.testnet',
    transport: async (_url, options) => {
      const query = JSON.parse(options.body);
      assert.equal(query.params.finality, 'final');
      return { ok: true, json: async () => ({ result: { result: [...Buffer.from(JSON.stringify({
        remaining: '4', version: '2', cancelled: false, expires_at_ns: '9000000000000000000',
      }))], block_hash: 'final-block', block_height: 100 } }) };
    } });
  const request = { owner: 'seller.testnet', orderId: 'salt', quantity: '2', expectedVersion: '2' };
  const tx = await client.prepareFill('buyer.testnet', request);
  assert.equal(tx.receiverId, 'core.demo.testnet');
  assert.equal(tx.actions[0].params.args.expected_version, '2');
  await assert.rejects(client.prepareFill('buyer.testnet', { ...request, expectedVersion: '1' }), /order_unavailable/);
  await assert.rejects(client.prepareFill('seller.testnet', request), /self_fill/);
});
