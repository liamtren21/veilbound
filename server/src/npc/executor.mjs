const digits = value => typeof value === 'string' && /^(?:0|[1-9]\d{0,38})$/.test(value);

/**
 * The caller supplies an already-authorized signer and a finalized receipt lookup.
 * The scheduler itself has no keys or permission-granting capability.
 */
export function createSignedActionAdapter({
  receiverId, methods, readContext, prepare, signAndSend, findFinal,
  maxGas = '100000000000000', maxDeposit = '1',
}) {
  if (typeof receiverId !== 'string' || !receiverId.endsWith('.testnet') ||
      !Array.isArray(methods) || methods.length === 0 || methods.some(method => typeof method !== 'string') ||
      [readContext, prepare, signAndSend, findFinal].some(fn => typeof fn !== 'function') ||
      !digits(maxGas) || !digits(maxDeposit)) throw new Error('invalid_signed_action_adapter');
  const check = transaction => {
    if (transaction?.receiverId !== receiverId || !Array.isArray(transaction.actions) ||
        transaction.actions.length !== 1) throw new Error('transaction_outside_policy');
    const [action] = transaction.actions;
    const params = action?.params;
    if (action?.type !== 'FunctionCall' || !methods.includes(params?.methodName) ||
        !digits(params.gas) || BigInt(params.gas) > BigInt(maxGas) ||
        !digits(params.deposit) || BigInt(params.deposit) > BigInt(maxDeposit) ||
        !params.args || typeof params.args !== 'object' || Array.isArray(params.args)) {
      throw new Error('transaction_outside_policy');
    }
    return transaction;
  };
  return {
    readContext,
    async prepare(job) {
      return structuredClone(check(await prepare(structuredClone(job))));
    },
    async submit(job) {
      const transaction = structuredClone(check(job.prepared));
      return signAndSend({ operationId: job.operationId, accountId: job.accountId, transaction });
    },
    findFinal: job => findFinal(structuredClone(job)),
  };
}
