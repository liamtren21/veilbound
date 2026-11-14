import test from 'node:test';
import assert from 'node:assert/strict';
import { createShopQuotes, stockPrices } from '../../server/src/npc/shop-operator.mjs';

const policy = {
  epoch: 1, expiresAt: Date.now() + 100000, methods: ['buy', 'sell'], itemIds: ['salt'],
  maxQuantity: 10, maxUnitPriceAtomic: '400', budgetRemainingAtomic: '10000', targetStock: { salt: 10 },
};
const pricing = { salt: { anchorAtomic: '100', spreadBps: 2000, stockImpactBps: 2000 } };
function fixture() {
  let now = Date.now();
  let stock = 3;
  let cash = '1000';
  const service = createShopQuotes({ now: () => now, policy, pricing,
    readSnapshot: async () => ({ accountId: 'shop.demo.testnet', epoch: 1, availableAtomic: cash, stock: { salt: stock }, blockHash: 'final-block' }),
    core: { prepareMarketOrder: args => ({ network: 'testnet', receiverId: 'core.demo.testnet', actions: [{
      type: 'FunctionCall', params: { methodName: 'place_market_order', args },
    }] }) },
  });
  return { service, stock: value => { stock = value; }, cash: value => { cash = value; }, time: value => { now = value; }, now };
}
test('quotes respond to inventory and preserve bid/ask ordering after actual ceil-three-percent fees', () => {
  const low = stockPrices({ stock: 0, target: 10, ...pricing.salt });
  const high = stockPrices({ stock: 20, target: 10, ...pricing.salt });
  assert.ok(BigInt(low.askAtomic) > BigInt(high.askAtomic));
  for (let stock = 0; stock < 100; stock++) {
    const q = stockPrices({ stock, target: 10, ...pricing.salt });
    assert.ok(BigInt(q.bidAtomic) < BigInt(q.askAtomic));
    assert.ok(BigInt(q.roundTripLossAtomic) > 0n);
  }
});
test('prepared orders require the inventory account, a live quote, unchanged price and sufficient capital', async () => {
  const f = fixture();
  const { quotes } = await f.service.quote('shop.demo.testnet');
  const bid = quotes.find(quote => quote.side === 'buy');
  const ask = quotes.find(quote => quote.side === 'sell');
  await assert.rejects(f.service.prepare('other.demo.testnet', { quoteId: bid.id, quantity: 1 }), /quote_missing/);
  const prepared = await f.service.prepare('shop.demo.testnet', { quoteId: ask.id, quantity: 2 });
  assert.equal(prepared.signerId, 'shop.demo.testnet');
  assert.equal(prepared.transaction.actions[0].params.args.price, ask.priceAtomic);
  f.cash('0');
  await assert.rejects(f.service.prepare('shop.demo.testnet', { quoteId: bid.id, quantity: 1 }), /insufficient_funds/);
  f.stock(20);
  await assert.rejects(f.service.prepare('shop.demo.testnet', { quoteId: ask.id, quantity: 1 }), /quote_changed/);
  f.time(ask.expiresAt);
  await assert.rejects(f.service.prepare('shop.demo.testnet', { quoteId: ask.id, quantity: 1 }), /quote_expired/);
});
