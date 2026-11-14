import assert from 'node:assert/strict';
import test from 'node:test';
import { openMarketIndex } from '../../server/src/orders/market-index.mjs';

test('published market orders require matching finalized transactions and discard closed orders', async () => {
  const args = { order_id: 'salt-1', token_id: 'salt', side: 'Sell', price: '50', quantity: '2', expires_at_ns: '2000000000' };
  const order = { ...args, remaining: '2', cancelled: false, version: '0' };
  const result = { final_execution_status: 'FINAL', status: { SuccessValue: '' },
    transaction: { hash: 'a'.repeat(44), signer_id: 'alice.testnet', receiver_id: 'core.vibebound.testnet', actions: [{ FunctionCall: {
      method_name: 'place_market_order', args: Buffer.from(JSON.stringify(args)).toString('base64'),
    } }] }, receipts_outcome: [] };
  const index = openMarketIndex(':memory:', { coreId: 'core.vibebound.testnet', now: () => 1000,
    economy: { order: async () => ({ value: order, blockHash: 'final-block' }) },
    transport: async () => ({ ok: true, json: async () => ({ result }) }) });
  try {
    const hash = 'a'.repeat(44);
    await assert.rejects(index.publish('bob.testnet', hash), /UNVERIFIED/);
    assert.equal((await index.publish('alice.testnet', hash)).orderId, 'salt-1');
    assert.equal((await index.list()).orders.length, 1);
    order.cancelled = true;
    assert.equal((await index.list()).orders.length, 0);
    await assert.rejects(index.publish('alice.testnet', hash), /CLOSED/);
  } finally { index.close(); }
});
