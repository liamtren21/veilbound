import { readFile } from 'node:fs/promises';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { openRunRewards } from './run-rewards.mjs';

const positive = value => typeof value === 'string' && /^[1-9]\d{0,38}$/.test(value);
export async function loadRewardSigningKey(env = process.env) {
  const { VEILBOUND_REWARD_KEY_PATH: path, VEILBOUND_REWARD_KEY: value } = env;
  if (Boolean(path) === Boolean(value)) throw new Error('Configure exactly one reward signing key source');
  return createPrivateKey(value ?? await readFile(path));
}
export async function bootstrapRunRewards({
  env = process.env, file, beneficiaryForPlayer, transport = fetch, now = Date.now,
} = {}) {
  if (env.VEILBOUND_REWARDS_ENABLED !== 'true') return undefined;
  const config = JSON.parse(await readFile(env.VEILBOUND_REWARD_CONFIG_PATH ??
    new URL('../../../deployments/testnet.config.json', import.meta.url), 'utf8'));
  if (config.network !== 'testnet' || env.VEILBOUND_CORE_ID !== 'core.' + config.rootAccountId ||
    env.VEILBOUND_COPPER_ID !== 'copper.' + config.rootAccountId) throw new Error('Reward deployment mismatch');
  const privateKey = await loadRewardSigningKey(env);
  const publicKey = createPublicKey(privateKey).export({ format: 'jwk' });
  if (publicKey.crv !== 'Ed25519' || Buffer.from(publicKey.x, 'base64url').toString('base64') !== config.receiptSigner) {
    throw new Error('Reward signer mismatch');
  }
  async function finalView(accountId, methodName, args = {}) {
    const response = await transport('https://test.rpc.fastnear.com', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 'reward-bootstrap', method: 'query', params: {
        request_type: 'call_function', account_id: accountId, method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'), finality: 'final',
      } }),
    });
    if (!response.ok) throw new Error('Reward chain unavailable');
    const { result, error } = await response.json();
    if (error || result?.error || !Array.isArray(result?.result) || !result.block_hash) throw new Error('Reward final view unavailable');
    return JSON.parse(Buffer.from(result.result).toString());
  }
  async function loadEpoch() {
    const [core, budget] = await Promise.all([
      finalView(env.VEILBOUND_CORE_ID, 'get_reward_config'),
      finalView(env.VEILBOUND_COPPER_ID, 'get_reward_budget'),
    ]);
    if (core.receipt_signer !== config.receiptSigner || core.ruleset !== config.ruleset ||
      core.copper_id !== env.VEILBOUND_COPPER_ID) throw new Error('Reward Core configuration mismatch');
    for (const key of ['epoch', 'epoch_length_ns', 'global_reward_cap', 'rewards_minted', 'epoch_reward_cap', 'epoch_minted']) {
      if (typeof budget[key] !== 'string' || !/^(0|[1-9]\d{0,38})$/.test(budget[key])) throw new Error('Invalid final reward budget');
    }
    if (budget.global_reward_cap !== config.globalRewardCap || budget.epoch_length_ns !== config.epochLengthNs ||
      budget.epoch_reward_cap !== config.epochRewardCap) throw new Error('Reward Copper configuration mismatch');
    const runBudgetAtomic = env.VEILBOUND_REWARD_RUN_ATOMIC ?? '10000';
    const epochBudgetAtomic = env.VEILBOUND_REWARD_EPOCH_ATOMIC ?? '20000';
    const totalBudgetAtomic = env.VEILBOUND_REWARD_TOTAL_ATOMIC ?? '100000';
    if (![runBudgetAtomic, epochBudgetAtomic, totalBudgetAtomic].every(positive) ||
      BigInt(totalBudgetAtomic) > BigInt(budget.global_reward_cap) - BigInt(budget.rewards_minted) ||
      BigInt(epochBudgetAtomic) > BigInt(budget.epoch_reward_cap) - BigInt(budget.epoch_minted)) {
      throw new Error('Reward allocation exceeds final chain capacity');
    }
    const epochLength = BigInt(budget.epoch_length_ns);
    const currentEpoch = BigInt(now()) * 1000000n / epochLength;
    if (currentEpoch !== BigInt(budget.epoch)) throw new Error('Reward epoch mismatch');
    const epochEndsAtMs = Number((currentEpoch + 1n) * epochLength / 1000000n);
    const service = openRunRewards(file, {
      privateKey, contractId: env.VEILBOUND_CORE_ID, ruleset: config.ruleset,
      epoch: budget.epoch, epochEndsAtMs, runBudgetAtomic, epochBudgetAtomic, totalBudgetAtomic,
      beneficiaryForPlayer, now,
      finalizedEpoch: budget.epoch,
      checkpointShares: [1500, 1500, 2000, 2000, 3000],
      readFinalClaim: receipt => finalView(env.VEILBOUND_CORE_ID, 'get_operation', {
        operation_id: receipt.claim_id, account_id: receipt.account_id, kind: 'reward',
      }),
    });
    return { service, endsAt: epochEndsAtMs };
  }

  let active = await loadEpoch();
  let refreshing;
  let closed = false;
  return {
    needsRefresh: () => now() >= active.endsAt,
    refresh() {
      if (closed) throw new Error('Reward service is closed');
      if (now() < active.endsAt) return Promise.resolve();
      refreshing ??= loadEpoch().then(next => {
        if (closed) { next.service.close(); return; }
        active.service.close();
        active = next;
      }).finally(() => { refreshing = undefined; });
      return refreshing;
    },
    reserve: (...args) => active.service.reserve(...args),
    prepare: (...args) => active.service.prepare(...args),
    reconcile: (...args) => active.service.reconcile(...args),
    close() { closed = true; active.service.close(); },
  };
}

