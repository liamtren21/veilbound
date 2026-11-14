import { sign } from 'node:crypto';

const fields = ['network', 'contract', 'ruleset', 'account_id', 'run_id', 'encounter_id',
  'sequence', 'entitlement_id', 'token_id', 'amount', 'expires_at_ns'];

export function materialRewardMessage(receipt) {
  return Buffer.from(['VEILBOUND_MATERIAL_REWARD_V1', ...fields.map(field => receipt[field])].join('\n'));
}

export function createMaterialClaims({ contractId, ruleset, privateKey, readBudget, readClaim, clock = Date.now }) {
  return {
    async readFinal(receipt) {
      const final = await readClaim(receipt.entitlement_id);
      if (!final) return false;
      if (fields.some(field => final[field] !== receipt[field])) {
        throw Object.assign(new Error('MATERIAL_CHAIN_CONFLICT'), { code: 'MATERIAL_CHAIN_CONFLICT', status: 409 });
      }
      return true;
    },
    async checkBudget(tokenId, amount) {
      const budget = await readBudget(tokenId);
      if (!Array.isArray(budget) || budget.length !== 2 ||
        budget.some(value => typeof value !== 'string' || !/^\d{1,39}$/.test(value)) ||
        BigInt(budget[0]) - BigInt(budget[1]) < BigInt(amount)) {
        throw Object.assign(new Error('MATERIAL_BUDGET_UNAVAILABLE'), { code: 'MATERIAL_BUDGET_UNAVAILABLE', status: 409 });
      }
    },
    receipt({ beneficiary, runId, node, sequence, entitlement }) {
      return {
        network: 'testnet', contract: contractId, ruleset, account_id: beneficiary, run_id: runId,
        encounter_id: node, sequence: String(sequence), entitlement_id: entitlement.entitlementId,
        token_id: entitlement.itemId, amount: entitlement.quantity,
        expires_at_ns: String(BigInt(clock() + 7 * 86400000) * 1000000n),
      };
    },
    transaction(receipt) {
      const signature = sign(null, materialRewardMessage(receipt), privateKey).toString('base64');
      return { network: 'testnet', receiverId: contractId, actions: [{
        type: 'FunctionCall', params: { methodName: 'claim_material_reward', args: { receipt, signature },
          gas: '100000000000000', deposit: '1' },
      }] };
    },
  };
}

