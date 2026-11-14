const previewProvider = 'tidepool';
const previewEndpoint = 'https://www.usetidepool.tech/v0/quote';
const previewIdentity = 'vibebound.testnet';
const origin = { assetId: 'nep141:usdc.tidepool-sandbox.testnet', symbol: 'tUSDC', decimals: 6 };
const destination = { assetId: 'nep141:wnear.tidepool-sandbox.testnet', symbol: 'twNEAR', decimals: 24 };
const slippageBps = 100;
const atomic = value => typeof value === 'string' && /^[1-9][0-9]{0,38}$/.test(value);

export function checkoutMethods() {
  return {
    network: 'testnet', methods: ['near-wallet'],
    intents: {
      available: false, reason: 'TESTNET_SETTLEMENT_UNAVAILABLE',
      preview: { provider: previewProvider, network: 'testnet', dryRun: true },
    },
  };
}

export async function previewTestnetIntentQuote({ transport = fetch, now = Date.now } = {}) {
  const request = {
    dry: true, swapType: 'EXACT_INPUT', slippageTolerance: slippageBps,
    originAsset: origin.assetId, destinationAsset: destination.assetId, amount: '1000000',
    depositType: 'ORIGIN_CHAIN', refundType: 'ORIGIN_CHAIN', recipientType: 'DESTINATION_CHAIN',
    refundTo: previewIdentity, recipient: previewIdentity, deadline: new Date(now() + 300000).toISOString(),
  };
  try {
    const response = await transport(previewEndpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error('Tidepool quote request rejected');
    const { quote, quoteRequest, timestamp, correlationId } = await response.json();
    if (Object.entries(request).some(([key, value]) => quoteRequest?.[key] !== value) ||
        quote?.depositAddress != null || quote?.depositMemo != null ||
        quote?.amountIn !== request.amount || !atomic(quote.amountOut) || !atomic(quote.minAmountOut) ||
        BigInt(quote.minAmountOut) > BigInt(quote.amountOut) ||
        !Number.isFinite(Date.parse(timestamp)) || typeof correlationId !== 'string' ||
        !/^[0-9a-f-]{36}$/i.test(correlationId)) throw new Error('Invalid Tidepool preview response');
    return {
      provider: previewProvider, network: 'testnet', dryRun: true,
      origin: { ...origin, amountAtomic: quote.amountIn },
      destination: { ...destination, amountAtomic: quote.amountOut, minAmountAtomic: quote.minAmountOut },
      slippageBps, quotedAt: timestamp, correlationId,
    };
  } catch (cause) {
    throw Object.assign(new Error('INTENTS_PREVIEW_UNAVAILABLE', { cause }), {
      code: 'INTENTS_PREVIEW_UNAVAILABLE', status: 503,
    });
  }
}
