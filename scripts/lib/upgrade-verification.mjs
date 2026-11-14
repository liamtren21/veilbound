import { createHash } from 'node:crypto';
import { planDigest } from './upgrade.mjs';

async function query(rpc, params) {
  const response = await rpc('query', params);
  if (response.error || response.result?.error || !response.result) throw new Error('Upgrade verification query failed');
  return response.result;
}

async function checkFinalCodeHash(plan, name, rpc, expected) {
  const result = await query(rpc, { request_type: 'view_account', account_id: plan.contracts[name], finality: 'final' });
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = BigInt('0x' + expected);
  let encoded = '';
  while (value) { encoded = alphabet[Number(value % 58n)] + encoded; value /= 58n; }
  encoded = '1'.repeat(expected.match(/^(00)*/)[0].length / 2) + encoded;
  if (result.code_hash !== encoded) throw new Error('Unexpected finalized ' + name + ' WASM hash');
}

export async function verifyCode(plan, name, rpc, blockHash, expected = plan.artifacts[name].sha256) {
  const result = await query(rpc, {
    request_type: 'view_code', account_id: plan.contracts[name],
    ...(blockHash ? { block_id: blockHash } : { finality: 'final' }),
  });
  const bytes = Buffer.from(result.code_base64, 'base64');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expected) throw new Error('Unexpected finalized ' + name + ' WASM hash');
  return { sha256, blockHash: result.block_hash, bytes: bytes.length };
}

export async function viewUpgrade(plan, method, args, rpc, name = 'core', blockHash) {
  const result = await query(rpc, {
    request_type: 'call_function', account_id: plan.contracts[name], method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    ...(blockHash ? { block_id: blockHash } : { finality: 'final' }),
  });
  return JSON.parse(Buffer.from(result.result).toString());
}

export async function preflightUpgrade(plan, index, rpc, verified) {
  if (plan.phase === 'unpause') {
    if (!verified || verified.status !== 'VERIFIED_PAUSED' || verified.upgradeDigest !== plan.requiresUpgradeDigest ||
        verified.artifacts.core.sha256 !== plan.artifacts.core.sha256 ||
        verified.artifacts.copper.sha256 !== plan.artifacts.copper.sha256) throw new Error('Matching paused upgrade verification is required');
    await Promise.all(['core', 'copper'].map(name => checkFinalCodeHash(plan, name, rpc, plan.artifacts[name].sha256)));
  } else if (plan.phase === 'upgrade') {
    await Promise.all(['copper', 'core'].map(async name => {
      const upgraded = plan.batches.slice(0, index).some(batch => batch.receiverId === plan.contracts[name] &&
        batch.actions.some(action => action.params?.methodName === 'upgrade'));
      const expected = upgraded ? plan.artifacts[name].sha256 : plan.previousArtifacts[name].sha256;
      await checkFinalCodeHash(plan, name, rpc, expected);
    }));
    if (index === 0) return { verified: true };
  } else return { verified: true };
  if (await viewUpgrade(plan, 'is_paused', {}, rpc) !== true) throw new Error('Core must be paused before this phase');
  return { verified: true };
}

export async function verifyUpgrade(plan, rpc) {
  if (plan.phase !== 'upgrade') throw new Error('Expected upgrade manifest');
  const block = await rpc('block', { finality: 'final' });
  const blockHash = block.result?.header?.hash;
  if (block.error || typeof blockHash !== 'string') throw new Error('Final block unavailable');
  const artifacts = Object.fromEntries(await Promise.all(['copper', 'core'].map(async name => [
    name, await verifyCode(plan, name, rpc, blockHash),
  ])));
  const checks = {};
  const feature = plan.feature === 'nft-run-lock' ? 'market-extension' : plan.feature;
  const specs = [
    ['paused', 'is_paused', {}, 'core'],
    ['metadata', 'ft_metadata', {}, 'copper'],
    ['supply', 'ft_total_supply', {}, 'copper'],
    ['custody', 'ft_balance_of', { account_id: plan.contracts.core }, 'copper'],
    ['allocated', 'get_total_allocated', {}, 'core'],
    ['budget', 'get_reward_budget', {}, 'copper'],
    ['rewardConfig', 'get_reward_config', {}, 'core'],
    ['starterConfiguration', 'get_starter_configuration', {}, 'core'],
    ['starterPool', 'get_starter_pool', {}, 'core'],
    ['artifactReceiptApi', 'get_artifact_job_receipt', { token_id: 'upgrade-verification-probe', operation_id: 'upgrade-verification-probe' }, 'core'],
    ['artifactWithdrawalApi', 'get_artifact_withdrawal', { token_id: 'upgrade-verification-probe', operation_id: 'upgrade-verification-probe' }, 'core'],
    ['chronicleApi', 'get_chronicle_entry', { token_id: 'upgrade-verification-probe', entry_id: 'upgrade-verification-probe' }, 'core'],
  ];
  for (const [key, method, args, name] of specs) checks[key] = await viewUpgrade(plan, method, args, rpc, name, blockHash);
  if (['field-rewards', 'run-items', 'economy', 'guest-spending', 'market-extension'].includes(feature)) {
    checks.fieldOperator = await viewUpgrade(plan, 'get_field_reward_operator', {}, rpc, 'core', blockHash);
    const probe = await viewUpgrade(plan, 'get_field_reward', { reservation_id: '0'.repeat(64) }, rpc, 'core', blockHash);
    if (probe !== null) throw new Error('Unexpected Field Contract probe reservation');
  }
  if (['run-items', 'economy', 'guest-spending', 'market-extension'].includes(feature)) {
    if (!checks.fieldOperator) throw new Error('Field operator configuration missing after upgrade');
    const reservation = await viewUpgrade(plan, 'get_run_item_reservation', {
      account_id: plan.rootAccountId, reservation_id: '0'.repeat(64),
    }, rpc, 'core', blockHash);
    if (reservation !== null) throw new Error('Unexpected run item reservation');
    checks.runItemsApi = true;
    checks.evolutionRecipes = await Promise.all([1, 2].map(stage =>
      viewUpgrade(plan, 'get_evolution_recipe', { stage }, rpc, 'core', blockHash)));
  }
  if (['economy', 'guest-spending', 'market-extension'].includes(feature)) {
    checks.shopOrders = await viewUpgrade(plan, 'get_shop_open_order_count', { token_id: 'shop-001' }, rpc, 'core', blockHash);
    checks.materialBudget = await viewUpgrade(plan, 'get_material_reward_budget', { token_id: 'resin' }, rpc, 'core', blockHash);
    checks.purseProbe = await viewUpgrade(plan, 'get_run_purse', {
      account_id: plan.rootAccountId, run_id: 'upgrade-verification-probe',
    }, rpc, 'core', blockHash);
    if (typeof checks.shopOrders !== 'string') throw new Error('Shop order counter unavailable');
    if (checks.purseProbe !== null) throw new Error('Unexpected run purse probe');
  }
  if (['guest-spending', 'market-extension'].includes(feature)) {
    const grant_id = '0'.repeat(64);
    const inventory = await viewUpgrade(plan, 'get_starter_inventory', { grant_id }, rpc, 'core', blockHash);
    const spend = await viewUpgrade(plan, 'get_starter_run_spend', {
      grant_id, run_id: 'upgrade-verification-probe',
    }, rpc, 'core', blockHash);
    if (inventory !== null || spend !== null) throw new Error('Unexpected Guest settlement probe');
    checks.guestSpendingApi = true;
  }
  if (feature === 'market-extension') {
    const probes = await Promise.all([
      viewUpgrade(plan, 'get_nft_rental', { token_id: 'upgrade-verification-probe' }, rpc, 'core', blockHash),
      viewUpgrade(plan, 'get_companion_bond', { token_id: 'upgrade-verification-probe' }, rpc, 'core', blockHash),
      viewUpgrade(plan, 'get_guild_treasury', { guild_id: 'upgrade-verification-probe' }, rpc, 'core', blockHash),
    ]);
    if (probes.some(value => value !== null)) throw new Error('Unexpected marketplace extension probe');
    checks.marketExtensionApi = true;
  }
  if (plan.feature === 'nft-run-lock') {
    const lock = await viewUpgrade(plan, 'get_nft_run_lock', { token_id: 'starter-001' }, rpc, 'core', blockHash);
    if (lock !== null) throw new Error('Unexpected starter run lock');
    checks.nftRunLockApi = true;
  }
  if (checks.paused !== true) throw new Error('Core must remain paused for upgrade verification');
  if (checks.custody !== checks.allocated) throw new Error('Copper custody and Core allocation differ');
  if (!checks.metadata || checks.metadata.symbol !== 'COPPER') throw new Error('Unexpected Copper metadata');
  if (checks.rewardConfig?.copper_id !== plan.contracts.copper || !checks.starterPool?.configuration) {
    throw new Error('Reward or starter configuration missing after upgrade');
  }
  checks.artifacts = {};
  for (const tokenId of ['starter-001', 'shop-001']) {
    const args = { token_id: tokenId };
    const artifact = await viewUpgrade(plan, 'get_artifact', args, rpc, 'core', blockHash);
    const token = await viewUpgrade(plan, 'nft_token', args, rpc, 'core', blockHash);
    if (artifact?.status !== 'ready' || !token?.owner_id || artifact.vault_id !== `v-${tokenId}.${plan.contracts.core}`) {
      throw new Error('Artifact state missing after upgrade: ' + tokenId);
    }
    const { keys } = await query(rpc, { request_type: 'view_access_key_list', account_id: artifact.vault_id, block_id: blockHash });
    if (!Array.isArray(keys) || keys.length !== 0) throw new Error('Expected keyless vault: ' + tokenId);
    checks.artifacts[tokenId] = { ownerId: token.owner_id, vaultId: artifact.vault_id };
  }
  return {
    status: 'VERIFIED_PAUSED', network: 'testnet', rootAccountId: plan.rootAccountId,
    upgradeDigest: planDigest(plan), checkedAt: new Date().toISOString(), blockHash, artifacts, checks,
  };
}
