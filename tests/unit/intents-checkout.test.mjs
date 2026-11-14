import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkoutMethods, previewTestnetIntentQuote } from '../../server/src/economy/intents-checkout.mjs';

const correlationId = 'e59791ab-3f56-4d8d-9496-12341c05cfa2';
const timestamp = '2026-11-14T00:00:00.000Z';
const quote = { amountIn: '1000000', amountOut: '300638293202416906880000', minAmountOut: '297631910270392737811200' };

test('Tidepool preview prices a fixed pair of sandbox assets without enabling settlement', async () => {
  const preview = await previewTestnetIntentQuote({
    now: () => Date.parse(timestamp),
    transport: async (url, { method, redirect, body }) => {
      const quoteRequest = JSON.parse(body);
      assert.equal(url, 'https://www.usetidepool.tech/v0/quote');
      assert.equal(method, 'POST');
      assert.equal(redirect, 'error');
      assert.equal(quoteRequest.dry, true);
      assert.equal(quoteRequest.originAsset, 'nep141:usdc.tidepool-sandbox.testnet');
      assert.equal(quoteRequest.destinationAsset, 'nep141:wnear.tidepool-sandbox.testnet');
      assert.equal(quoteRequest.deadline, '2026-11-14T00:05:00.000Z');
      return Response.json({ correlationId, timestamp, quoteRequest, quote });
    },
  });
  assert.equal(preview.origin.amountAtomic, quote.amountIn);
  assert.equal(preview.destination.minAmountAtomic, quote.minAmountOut);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.network, 'testnet');
  assert.equal(preview.provider, 'tidepool');
  assert.deepEqual(checkoutMethods().methods, ['near-wallet']);
  assert.equal(checkoutMethods().intents.available, false);
});

test('Tidepool preview discards mismatched assets, deposit instructions and upstream failures', async () => {
  for (const invalid of [
    (req) => Response.json({ correlationId, timestamp, quoteRequest: req, quote: { ...quote, depositAddress: 'alice.testnet' } }),
    (req) => Response.json({ correlationId, timestamp, quoteRequest: { ...req, destinationAsset: 'nep141:wrap.near' }, quote }),
    () => new Response('', { status: 503 }),
    () => { throw new Error('offline'); },
  ]) {
    await assert.rejects(previewTestnetIntentQuote({
      transport: async (_url, { body }) => invalid(JSON.parse(body)),
    }), { code: 'INTENTS_PREVIEW_UNAVAILABLE', status: 503 });
  }
});
