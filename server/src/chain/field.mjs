const idPattern = /^[a-f0-9]{64}$/;
const accountPattern = /^(?:[a-z0-9]+(?:[-_.][a-z0-9]+)*\.testnet|[a-f0-9]{64})$/;
const maxAmount = (1n << 128n) - 1n;
const maxTime = (1n << 64n) - 1n;

function validAccount(value) {
  return typeof value === 'string' && value.length <= 64 && accountPattern.test(value);
}

export function createFieldRewardFunder({ coreId, operatorId, beneficiaryFor, readFinal, signAndSend, now = Date.now }) {
  if (!validAccount(coreId) || !validAccount(operatorId) ||
      [beneficiaryFor, readFinal, signAndSend].some(method => typeof method !== 'function')) {
    throw new Error('field_funder_configuration_invalid');
  }
  const actionStatuses = { reserve: 'reserved', pay: 'paid', release: 'released' };
  function validate(intent, action) {
    if (!idPattern.test(intent.reservationId) || intent.operationId !== intent.reservationId + ':' + action ||
        typeof intent.amountAtomic !== 'string' || !/^[1-9]\d{0,38}$/.test(intent.amountAtomic) ||
        BigInt(intent.amountAtomic) > maxAmount || !Number.isSafeInteger(intent.endsAt) ||
        intent.endsAt < 1 || BigInt(intent.endsAt) * 1_000_000n > maxTime) throw new Error('invalid_field_operation');
  }
  async function invoke(intent, action) {
    validate(intent, action);
    const { reservationId, operationId, accountId, amountAtomic, endsAt } = intent;
    const beneficiary = action === 'reserve' ? await beneficiaryFor(accountId) : intent.reservation?.beneficiary;
    if (!validAccount(beneficiary) || beneficiary === operatorId || beneficiary === coreId) throw new Error('field_beneficiary_unverified');
    if (action === 'pay' && (!Number.isSafeInteger(intent.evidence?.clearSequence) ||
        !Number.isSafeInteger(intent.evidence?.checkpointSequence) ||
        intent.evidence.checkpointSequence <= intent.evidence.clearSequence ||
        intent.evidence.tradable !== false)) throw new Error('field_evidence_required');
    const expiresAtNs = (BigInt(endsAt) * 1_000_000n).toString();
    const inspect = async () => {
      const finalized = await readFinal(reservationId);
      if (!finalized) return null;
      const { value, blockHash, finalizedAtNs } = finalized;
      const expired = typeof finalizedAtNs === 'string' && /^\d+$/.test(finalizedAtNs) &&
        BigInt(finalizedAtNs) >= BigInt(expiresAtNs);
      if (!value) {
        if (action === 'reserve' && expired) throw new Error('field_reservation_expired_without_funding');
        return null;
      }
      if (!blockHash || value.beneficiary !== beneficiary || value.amount !== amountAtomic ||
          value.expires_at_ns !== expiresAtNs || value.operator_id !== operatorId || !Object.values(actionStatuses).includes(value.status)) {
        throw new Error('field_reservation_binding_mismatch');
      }
      if (value.status === actionStatuses[action]) return { status: 'final', operationId, beneficiary, blockHash };
      if (action !== 'reserve' && value.status === 'reserved') {
        if (action === 'pay' && expired) throw new Error('field_payment_expired');
        return null;
      }
      throw new Error('field_reservation_state_conflict');
    };
    const prior = await inspect();
    if (prior) return prior;
    if (action !== 'release' && endsAt <= now()) throw new Error('contract_settlement_pending');
    const args = action === 'reserve' ? {
      operation_id: reservationId, beneficiary, amount: amountAtomic, expires_at_ns: expiresAtNs,
    } : { reservation_id: reservationId };
    const methodName = action + '_field_reward';
    try {
      await signAndSend({ operationId, signerId: operatorId, transaction: {
        network: 'testnet', receiverId: coreId, actions: [{
          type: 'FunctionCall', params: { methodName, args, gas: '60000000000000', deposit: '0' },
        }],
      } });
    } catch {
      const reconciled = await inspect();
      if (reconciled) return reconciled;
      throw new Error('contract_settlement_pending');
    }
    const confirmed = await inspect();
    if (!confirmed) throw new Error('contract_settlement_pending');
    return confirmed;
  }
  return Object.fromEntries(Object.keys(actionStatuses).map(action => [action, intent => invoke(intent, action)]));
}



