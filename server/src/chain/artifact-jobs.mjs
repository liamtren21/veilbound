const account = /^(?:[a-z0-9]+(?:[-_.][a-z0-9]+)*\.testnet|[a-f0-9]{64})$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,95}$/;

export function createArtifactJobViews({ coreId, transport = fetch }) {
  if (typeof coreId !== 'string' || coreId.length > 64 || !account.test(coreId)) throw new Error('invalid_core_account');
  async function rpc(method, params) {
    const response = await transport('https://test.rpc.fastnear.com', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'artifact-job-view', method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('chain_unavailable');
    const { result, error } = await response.json();
    if (error || result?.error || !result) throw new Error('chain_query_failed');
    return result;
  }
  const finalBlock = async () => {
    const result = await rpc('block', { finality: 'final' });
    if (typeof result.header?.hash !== 'string') throw new Error('chain_block_unavailable');
    return result.header.hash;
  };
  const view = async (blockHash, methodName, args) => {
    const result = await rpc('query', {
      request_type: 'call_function', account_id: coreId, method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'), block_id: blockHash,
    });
    if (!Array.isArray(result.result) || result.block_hash !== blockHash) throw new Error('chain_snapshot_mismatch');
    return JSON.parse(Buffer.from(result.result).toString());
  };
  const check = id => {
    if (typeof id !== 'string' || !identifier.test(id)) throw new Error('invalid_artifact_id');
  };
  return {
    async readArtifactContext(tokenId) {
      check(tokenId);
      const blockHash = await finalBlock();
      const args = { token_id: tokenId };
      const [artifact, policy, sale] = await Promise.all([
        view(blockHash, 'get_artifact', args),
        view(blockHash, 'get_artifact_policy', args),
        view(blockHash, 'get_nft_sale', args),
      ]);
      if (!artifact || !policy) throw new Error('policy_inactive');
      const [recipe, balance] = await Promise.all([
        view(blockHash, 'get_recipe', { recipe_id: policy.recipe_id }),
        view(blockHash, 'get_balance', { account_id: artifact.vault_id }),
      ]);
      if (!Array.isArray(recipe?.input_ids)) throw new Error('invalid_artifact_recipe');
      const balances = await Promise.all(recipe.input_ids.map(itemId =>
        view(blockHash, 'get_item_balance', { account_id: artifact.vault_id, token_id: itemId })));
      return { blockHash, artifact, policy, sale, recipe, balance,
        inputs: Object.fromEntries(recipe.input_ids.map((itemId, index) => [itemId, balances[index]])) };
    },
    async getFinalArtifactJob(tokenId, operationId) {
      check(tokenId);
      check(operationId);
      const blockHash = await finalBlock();
      const recipeId = await view(blockHash, 'get_artifact_job_receipt', { token_id: tokenId, operation_id: operationId });
      return recipeId === null ? null : { blockHash, recipeId };
    },
  };
}
