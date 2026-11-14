import { createHash } from 'node:crypto';
import { createSignedActionAdapter } from './executor.mjs';

const amount = value => {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,38})$/.test(value)) throw new Error('invalid_artifact_amount');
  const result = BigInt(value);
  if (result > (1n << 128n) - 1n) throw new Error('invalid_artifact_amount');
  return result;
};
const safeNumber = value => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('invalid_artifact_count');
  return number;
};

export function createArtifactCraftAdapter({ coreId, operatorId, chain, signAndSend, now = Date.now }) {
  if (!chain || typeof chain.readArtifactContext !== 'function' ||
      typeof chain.getFinalArtifactJob !== 'function') throw new Error('artifact_chain_adapter_required');
  const context = async tokenId => {
    const data = await chain.readArtifactContext(tokenId);
    const { policy, recipe, artifact, balance, inputs } = data;
    if (!data.blockHash || !policy || !recipe || !artifact || !balance ||
        policy.operator !== operatorId || policy.epoch !== artifact.epoch ||
        artifact.status !== 'ready' || artifact.transfer_pending || data.sale) throw new Error('policy_inactive');
    const expiryNs = amount(policy.expires_at_ns);
    if (expiryNs <= BigInt(now()) * 1_000_000n ||
        amount(policy.completed) >= amount(policy.max_jobs)) throw new Error('policy_inactive');
    if (!Array.isArray(recipe.input_ids) || recipe.input_ids.length === 0 ||
        recipe.input_ids.length !== recipe.input_amounts?.length ||
        recipe.input_ids.some((itemId, index) => amount(inputs?.[itemId]?.available ?? '0') < amount(recipe.input_amounts[index]))) {
      throw new Error('insufficient_artifact_inputs');
    }
    const budget = amount(policy.copper_budget) - amount(policy.spent);
    if (budget < 0n) throw new Error('policy_inactive');
    const cost = amount(recipe.copper_cost).toString();
    return {
      policy: {
        epoch: safeNumber(policy.epoch), expiresAt: safeNumber(expiryNs / 1_000_000n),
        methods: ['craft'], itemIds: [recipe.output_id], maxQuantity: 1,
        maxUnitPriceAtomic: cost, budgetRemainingAtomic: budget.toString(),
      },
      snapshot: { epoch: safeNumber(artifact.epoch), availableAtomic: amount(balance.available).toString(), stock: {} },
      authority: { recipeId: policy.recipe_id, recipe, operator: policy.operator },
      recipeId: policy.recipe_id, outputId: recipe.output_id, cost,
    };
  };
  return createSignedActionAdapter({
    receiverId: coreId, methods: ['execute_artifact_craft'], signAndSend,
    readContext: ({ accountId }) => context(accountId),
    async prepare(job) {
      const current = await context(job.accountId);
      const authorityFingerprint = createHash('sha256').update(JSON.stringify(current.authority)).digest('hex');
      if (authorityFingerprint !== job.authorityFingerprint || current.policy.epoch !== job.action.epoch || current.outputId !== job.action.itemId ||
          current.cost !== job.action.unitPriceAtomic || job.action.quantity !== 1 ||
          job.action.method !== 'craft') throw new Error('npc_job_policy_changed');
      return { network: 'testnet', receiverId: coreId, actions: [{
        type: 'FunctionCall', params: { methodName: 'execute_artifact_craft',
          args: { token_id: job.accountId, operation_id: job.operationId,
            expected_epoch: String(job.action.epoch), expected_recipe_id: current.recipeId },
          gas: '100000000000000', deposit: '1' },
      }] };
    },
    async findFinal(job) {
      const proof = await chain.getFinalArtifactJob(job.accountId, job.operationId);
      if (!proof) return null;
      if (!proof.blockHash || typeof proof.recipeId !== 'string' || proof.recipeId !== job.authority?.recipeId) throw new Error('invalid_artifact_receipt');
      return { status: 'final', receiptId: JSON.stringify([job.accountId, job.operationId]),
        blockHash: proof.blockHash, recipeId: proof.recipeId };
    },
  });
}


