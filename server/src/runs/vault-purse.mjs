import { sign } from 'node:crypto';

const CARRY_LIMIT = 4000n;
const fields = receipt => [receipt.network, receipt.contract, receipt.ruleset, receipt.account_id,
  receipt.run_id, receipt.amount, receipt.expires_at_ns];

export function validateVaultPurseCarry(amount) {
  if (typeof amount !== 'string' || !/^(?:0|[1-9]\d{0,3})$/.test(amount) ||
    BigInt(amount) > CARRY_LIMIT || BigInt(amount) % 100n !== 0n) return 'INVALID_PURSE_CARRY';
  return amount === '0' ? null : 'VAULT_PURSE_UNAVAILABLE';
}

export function createVaultPurse({ contractId, ruleset, privateKey, readPurse, clock = Date.now }) {
  function transaction(methodName, receipt, message, deposit) {
    return { network: 'testnet', receiverId: contractId, actions: [{
      type: 'FunctionCall', params: { methodName, gas: '100000000000000', deposit,
        args: { receipt, signature: sign(null, Buffer.from(message.join('\n')), privateKey).toString('base64') } },
    }] };
  }
  return {
    receipt(run, amount) {
      return {
        network: 'testnet', contract: contractId, ruleset, account_id: run.rewardReservation.beneficiary,
        run_id: run.runId, amount, expires_at_ns: String(BigInt(clock() + 3600000) * 1000000n),
      };
    },
    reserve: receipt => transaction('reserve_run_purse', receipt, ['VEILBOUND_RUN_PURSE_RESERVE_V1', ...fields(receipt)], '1'),
    async confirmed(receipt) {
      const record = await readPurse(receipt.account_id, receipt.run_id);
      return record?.close === null && fields(receipt).every((value, index) => fields(record.reservation)[index] === value);
    },
    async settlement(receipt) {
      const record = await readPurse(receipt.account_id, receipt.run_id);
      if (!record || !fields(receipt).every((value, index) => fields(record.reservation)[index] === value)) return 'unreserved';
      if (record.settled) return 'settled';
      return record.close ? 'pending' : 'reserved';
    },
    close(reservation, version, purse) {
      const receipt = { reservation, sequence: String(version), returned: String(purse.returned * 100),
        spent: String(purse.spent * 100), lost: String(purse.lost * 100) };
      return transaction('close_run_purse', receipt, ['VEILBOUND_RUN_PURSE_CLOSE_V1', ...fields(reservation),
        receipt.sequence, receipt.returned, receipt.spent, receipt.lost], '0');
    },
  };
}

export function accountForPurse(before, state, checkpoint) {
  if (!before.vaultPurse) return;
  const purse = { ...before.vaultPurse };
  const decrease = Math.max(0, before.copper - state.copper);
  // Use unminted run earnings before consuming Vault Copper.
  const backedSpend = Math.max(0, decrease - (before.copper - purse.remaining));
  purse.spent += backedSpend;
  purse.remaining -= backedSpend;
  if (checkpoint) {
    const banked = Number(BigInt(checkpoint.copperAtomic) / 100n);
    const returned = Math.min(banked, purse.remaining);
    purse.returned += returned;
    purse.remaining -= returned;
    checkpoint.vaultReturnAtomic = String(returned * 100);
    checkpoint.copperAtomic = String((banked - returned) * 100);
  }
  if (state.phase === 'defeat') {
    purse.lost = purse.remaining;
    purse.remaining = 0;
  }
  state.vaultPurse = purse;
}

