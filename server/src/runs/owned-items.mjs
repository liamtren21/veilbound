import { createHash, sign } from 'node:crypto';
import { tokenCapacity, tokens } from '../../../expedition-data.mjs';

const packKeys = { salve: 'salve', ward: 'guard-token' };
const fields = r => [r.network, r.contract, r.ruleset, r.account_id, r.run_id, r.reservation_id,
  JSON.stringify(r.token_ids), JSON.stringify(r.amounts), r.reserve_sequence, r.expires_at_ns];
export function createOwnedItems({ coreId, ruleset, privateKey, readReservation, now = Date.now }) {
  const transaction = (methodName, receipt, suffix, deposit) => ({ network: 'testnet', receiverId: coreId,
    actions: [{ type: 'FunctionCall', params: { methodName, gas: '100000000000000', deposit,
      args: { receipt, signature: sign(null, Buffer.from(suffix.join('\n')), privateKey).toString('base64') } } }] });
  return {
    prepare(run, items) {
      if (!items || Array.isArray(items) || typeof items !== 'object') return null;
      const ids = Object.keys(items).sort();
      if (!ids.length || ids.some(id => !Object.hasOwn(packKeys, id) || !Number.isSafeInteger(items[id]) || items[id] < 1 || items[id] > 5)) return null;
      if (ids.reduce((n, id) => n + items[id], 0) + Object.keys(tokens).reduce((n, id) => n + (run.state.pack[id] ?? 0), 0) > tokenCapacity) return null;
      const account = run.rewardReservation.beneficiary;
      return { network: 'testnet', contract: coreId, ruleset, account_id: account, run_id: run.runId,
        reservation_id: createHash('sha256').update(`run-items:${run.runId}`).digest('hex'), token_ids: ids,
        amounts: ids.map(id => String(items[id])), reserve_sequence: '0',
        expires_at_ns: String(BigInt(now() + 3600000) * 1000000n) };
    },
    reserve: receipt => transaction('reserve_run_items', receipt, ['VEILBOUND_RUN_ITEMS_RESERVE_V1', ...fields(receipt)], '1'),
    async confirmed(receipt) {
      const record = await readReservation(receipt);
      return record?.consumed === null && fields(receipt).every((field, index) => field === fields(record.reservation)[index]);
    },
    async settlement(receipt) {
      const record = await readReservation(receipt);
      if (!record || !fields(receipt).every((value, index) => fields(record.reservation)[index] === value)) return 'unreserved';
      return record.consumed === null ? 'reserved' : 'settled';
    },
    close(reservation, consumed, version) {
      const close_sequence = String(version);
      return transaction('close_run_items', { reservation, consumed, close_sequence },
        ['VEILBOUND_RUN_ITEMS_CLOSE_V1', ...fields(reservation), JSON.stringify(consumed), close_sequence], '0');
    },
  };
}

export const ownedPackKey = id => packKeys[id];
