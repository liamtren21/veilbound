export async function prepareProcurementDelivery(chain, input, now) {
  const order = await chain.getFinalizedBuyOrder(input.orderId);
  if (!order || order.status !== 'open' || order.endsAt <= now) throw new Error('order_unavailable');
  if (order.buyer === input.accountId) throw new Error('self_fill');
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0 || input.quantity > order.remaining) throw new Error('invalid_quantity');
  const ids = new Set();
  let available = 0;
  for (const lot of input.lots ?? []) {
    if (lot.accountId !== input.accountId || lot.provenance !== 'settled' || lot.itemId !== order.itemId ||
        !lot.id || ids.has(lot.id) || !Number.isSafeInteger(lot.quantity) || lot.quantity <= 0) throw new Error('invalid_stock');
    ids.add(lot.id);
    available += lot.quantity;
  }
  if (!Number.isSafeInteger(available) || available < input.quantity) throw new Error('insufficient_stock');
  const payout = BigInt(order.unitPriceAtomic) * BigInt(input.quantity);
  if (payout <= 0n || payout > BigInt(order.reservedCopperAtomic)) throw new Error('insufficient_escrow');
  return { orderId: order.id, quantity: input.quantity, accountId: input.accountId, expectedVersion: order.version, payoutAtomic: String(payout) };
}
