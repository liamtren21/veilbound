const atomic = value => {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,38})$/.test(value)) throw new Error('invalid_atomic_amount');
  const amount = BigInt(value);
  if (amount > (1n << 128n) - 1n) throw new Error('invalid_atomic_amount');
  return amount;
};

export function validateProposal({ proposal, policy, snapshot, now = Date.now() }) {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(policy.expiresAt) ||
      !Number.isSafeInteger(policy.epoch) || policy.epoch < 0 ||
      !Number.isSafeInteger(snapshot.epoch) || !Number.isSafeInteger(policy.maxQuantity) || policy.maxQuantity < 1 ||
      !Array.isArray(policy.methods) || !Array.isArray(policy.itemIds)) throw new Error('invalid_policy');
  if (policy.revoked || policy.expiresAt <= now || policy.epoch !== snapshot.epoch) throw new Error('policy_inactive');
  if (snapshot.pending || snapshot.locked || snapshot.listed) throw new Error('account_locked');
  if (!policy.methods.includes(proposal.method) || !policy.itemIds.includes(proposal.itemId)) throw new Error('action_outside_policy');
  if (!['buy', 'sell', 'craft'].includes(proposal.method)) throw new Error('invalid_action');
  if (!Number.isSafeInteger(proposal.quantity) || proposal.quantity <= 0 ||
      proposal.quantity > policy.maxQuantity || !Number.isSafeInteger(proposal.quoteExpiresAt) || proposal.quoteExpiresAt <= now) throw new Error('invalid_quote');
  const price = atomic(proposal.unitPriceAtomic);
  if (price === 0n) throw new Error('invalid_quote');
  const cost = price * BigInt(proposal.quantity);
  if (price > atomic(policy.maxUnitPriceAtomic) || cost > atomic(policy.budgetRemainingAtomic)) throw new Error('policy_budget_exceeded');
  if (proposal.method !== 'sell' && cost > atomic(snapshot.availableAtomic)) throw new Error('insufficient_funds');
  if (proposal.method === 'sell' && (snapshot.stock[proposal.itemId] ?? 0) < proposal.quantity) throw new Error('insufficient_stock');
  return { method: proposal.method, itemId: proposal.itemId, quantity: proposal.quantity,
    unitPriceAtomic: String(price), costAtomic: String(cost), epoch: policy.epoch,
    quoteExpiresAt: proposal.quoteExpiresAt };
}

export function planRestock({ policy, snapshot, quotes, now = Date.now() }) {
  const proposals = [];
  let budget = atomic(policy.budgetRemainingAtomic);
  let cash = atomic(snapshot.availableAtomic);
  for (const itemId of policy.itemIds) {
    const desired = Math.max(0, (policy.targetStock[itemId] ?? 0) - (snapshot.stock[itemId] ?? 0));
    const quote = quotes[itemId];
    if (!desired || !quote || quote.expiresAt <= now) continue;
    const price = atomic(quote.askAtomic);
    if (price <= 0n || price > atomic(policy.maxUnitPriceAtomic)) continue;
    const max = [BigInt(desired), BigInt(policy.maxQuantity), budget / price, cash / price]
      .reduce((a, b) => a < b ? a : b);
    if (max <= 0n) continue;
    const proposal = { method: 'buy', itemId, quantity: Number(max),
      unitPriceAtomic: quote.askAtomic, quoteExpiresAt: quote.expiresAt };
    const action = validateProposal({ proposal, policy: { ...policy, budgetRemainingAtomic: String(budget) },
      snapshot: { ...snapshot, availableAtomic: String(cash) }, now });
    proposals.push(action);
    budget -= atomic(action.costAtomic);
    cash -= atomic(action.costAtomic);
  }
  return { planner: 'rule-based', actions: proposals };
}

