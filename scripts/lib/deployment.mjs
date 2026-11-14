import { createHash } from 'node:crypto';

const numeric = (value, name) => {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || BigInt(value) > (1n << 128n) - 1n) {
    throw new Error('Invalid positive atomic amount: ' + name);
  }
  return value;
};
const call = (methodName, args) => ({
  type: 'FunctionCall', params: { methodName, args, gas: '50000000000000', deposit: '0' },
});

export function makeDeploymentPlan(config, binaries) {
  if (config.network !== 'testnet') throw new Error('Expected NEAR testnet');
  const root = config.rootAccountId;
  if (typeof root !== 'string' || !/^[a-z0-9]+(?:[-_.][a-z0-9]+)*\.testnet$/.test(root) || root.length > 57) {
    throw new Error('Expected a valid project testnet account with room for subaccounts');
  }
  if (typeof config.receiptSigner !== 'string' || Buffer.from(config.receiptSigner, 'base64').length !== 32 ||
      Buffer.from(config.receiptSigner, 'base64').toString('base64') !== config.receiptSigner) {
    throw new Error('Expected raw 32-byte receipt public key in base64');
  }
  if (!/^[\w:.\-]{1,96}$/.test(config.ruleset)) throw new Error('Invalid ruleset');
  for (const name of ['bootstrapCap', 'globalRewardCap', 'epochLengthNs', 'epochRewardCap', 'copperFundingYocto', 'coreFundingYocto']) numeric(config[name], name);
  if (BigInt(config.epochLengthNs) > (1n << 64n) - 1n) throw new Error('Epoch length exceeds u64');
  const artifacts = {};
  for (const name of ['copper', 'core', 'vault']) {
    const bytes = binaries[name];
    if (!Buffer.isBuffer(bytes) || bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([0,97,115,109,1,0,0,0]))) {
      throw new Error('Invalid WASM for ' + name);
    }
    artifacts[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  const copperId = 'copper.' + root;
  const coreId = 'core.' + root;
  const deployment = (name, receiverId, args) => ({
    signerId: root, receiverId,
    actions: [
      { type: 'CreateAccount' },
      { type: 'Transfer', params: { deposit: config[name + 'FundingYocto'] } },
      { type: 'DeployContract', params: { code: binaries[name].toString('base64') } },
      call('new', args),
    ],
  });
  return {
    network: 'testnet', status: 'UNSIGNED', rootAccountId: root,
    contracts: { copper: copperId, core: coreId },
    artifacts,
    batches: [
      deployment('copper', copperId, {
        owner_id: root, core_id: coreId,
        bootstrap_cap: config.bootstrapCap, global_reward_cap: config.globalRewardCap,
        epoch_length_ns: config.epochLengthNs, epoch_reward_cap: config.epochRewardCap,
      }),
      deployment('core', coreId, {
        owner_id: root, copper_id: copperId, receipt_signer: config.receiptSigner, ruleset: config.ruleset,
      }),
      { signerId: root, receiverId: coreId, actions: [
        call('pin_vault_template', { code_hash: Buffer.from(artifacts.vault.sha256, 'hex').toString('base64') }),
      ] },
    ],
  };
}
