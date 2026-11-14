import { createHash, sign } from 'node:crypto';

const reject = code => { throw Object.assign(new Error(code), { code, status: 409 }); };

export function createChronicle({ coreId, ruleset, privateKey, economy, runs, accountForPlayer, now = Date.now }) {
  async function milestone(player, runId, achievement) {
    const region = { 'region-3-clear': 3, 'five-region-clear': 5 }[achievement];
    if (region !== 3 && region !== 5) reject('CHRONICLE_ACHIEVEMENT_INVALID');
    const proof = await runs.verifyProgress(player, runId);
    const binding = proof.chronicleBinding;
    if (proof.mode !== 'expedition' || !binding || binding.accountId !== accountForPlayer(player) ||
        !proof.checkpoints.some(checkpoint => checkpoint.region === region)) reject('CHRONICLE_MILESTONE_UNAVAILABLE');
    const entryId = createHash('sha256').update(JSON.stringify([runId, binding.tokenId, achievement])).digest('hex');
    return { binding, entryId, stage: region === 3 ? 1 : 2 };
  }
  return {
    async bind(player, tokenId) {
      const accountId = accountForPlayer(player);
      if (!accountId) reject('LINKED_CHAIN_ACCOUNT_REQUIRED');
      const { token, artifact, sale } = await economy.artifact(tokenId);
      if (!token.blockHash || artifact.blockHash !== token.blockHash || sale.blockHash !== token.blockHash ||
          token.value?.owner_id !== accountId || artifact.value?.kind !== 'RELIC' ||
          artifact.value.status !== 'ready' || artifact.value.transfer_pending || sale.value) reject('RELIC_UNAVAILABLE');
      return { tokenId, accountId, epoch: artifact.value.epoch };
    },
    async prepare(player, runId, achievement) {
      const { binding, entryId } = await milestone(player, runId, achievement);
      const current = await this.bind(player, binding.tokenId);
      if (current.epoch !== binding.epoch) reject('RELIC_BINDING_CHANGED');
      const receipt = { network: 'testnet', contract: coreId, ruleset, account_id: binding.accountId,
        run_id: runId, token_id: binding.tokenId, artifact_epoch: binding.epoch, entry_id: entryId,
        achievement, expires_at_ns: String(BigInt(now() + 900000) * 1000000n) };
      const signature = sign(null, Buffer.from(['VEILBOUND_CHRONICLE_V1', ...Object.values(receipt)].join('\n')), privateKey).toString('base64');
      return { network: 'testnet', receiverId: coreId, actions: [{ type: 'FunctionCall', params: {
        methodName: 'record_signed_chronicle', args: { receipt, signature }, gas: '80000000000000', deposit: '1',
      } }] };
    },
    async evolution(player, runId, achievement) {
      const { binding, entryId, stage } = await milestone(player, runId, achievement);
      const { token, artifact, sale, stage: current } = await economy.artifact(binding.tokenId);
      if (!token.blockHash || [artifact, sale, current].some(part => part.blockHash !== token.blockHash) ||
          token.value?.owner_id !== binding.accountId || artifact.value?.kind !== 'RELIC' ||
          artifact.value.status !== 'ready' || artifact.value.transfer_pending || sale.value) reject('RELIC_UNAVAILABLE');
      const entry = await economy.chronicleEntry(binding.tokenId, entryId, token.blockHash);
      if (entry.blockHash !== token.blockHash || !entry.value || entry.value.achievement !== achievement ||
          entry.value.ruleset !== ruleset || entry.value.run_id !== runId) {
        return { status: 'milestone_pending', stage };
      }
      if (current.value >= stage) return { status: 'evolved', stage };
      if (current.value !== stage - 1) return { status: 'previous_stage_required', stage };
      const recipe = await economy.evolutionRecipe(stage, token.blockHash);
      if (recipe.blockHash !== token.blockHash || !recipe.value) return { status: 'recipe_unavailable', stage };
      const cost = { copperAtomic: recipe.value.copper_cost,
        items: recipe.value.item_ids.map((id, i) => ({ id, quantity: recipe.value.amounts[i] })) };
      const resources = await economy.evolutionResources(binding.accountId, binding.tokenId, recipe.value.item_ids, token.blockHash);
      if (resources.locked) return { status: 'relic_locked', stage, cost };
      const missing = {
        copper: BigInt(resources.copperAtomic) < BigInt(cost.copperAtomic),
        storage: BigInt(resources.storageYocto) < 10_000_000_000_000_000_000_000n,
        items: cost.items.filter((item, index) => BigInt(resources.items[index]) < BigInt(item.quantity)).map(item => item.id),
      };
      if (missing.copper || missing.storage || missing.items.length) return { status: 'resources_needed', stage, cost, missing };
      return { status: 'ready', stage, cost,
        transaction: economy.prepareEvolution({ tokenId: binding.tokenId, stage, entryId, recipe: recipe.value }) };
    },
  };
}
