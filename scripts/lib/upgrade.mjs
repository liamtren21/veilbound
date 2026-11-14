import { createHash } from 'node:crypto';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};
export const planDigest = plan => digest(JSON.stringify(canonical(plan)));
const call = (methodName, args, gas = '50000000000000') => ({
  type: 'FunctionCall', params: { methodName, args, gas, deposit: '0' },
});

export function makeUpgradePlans({ rootAccountId, binaries, previousArtifacts, feature }) {
  if (typeof rootAccountId !== 'string' || !/^[a-z0-9]+(?:[-_.][a-z0-9]+)*\.testnet$/.test(rootAccountId)) {
    throw new Error('invalid_upgrade_account');
  }
  const artifacts = {};
  for (const name of ['copper', 'core']) {
    const bytes = binaries[name];
    if (!Buffer.isBuffer(bytes) || bytes.length < 8 ||
        !bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])) ||
        !/^[a-f0-9]{64}$/.test(previousArtifacts?.[name]?.sha256 ?? '')) throw new Error('invalid_upgrade_artifact');
    artifacts[name] = { bytes: bytes.length, sha256: digest(bytes) };
  }
  const contracts = { copper: 'copper.' + rootAccountId, core: 'core.' + rootAccountId };
  const common = { network: 'testnet', status: 'UNSIGNED', rootAccountId, contracts, artifacts };
  const batch = (name, action) => ({ signerId: rootAccountId, receiverId: contracts[name], actions: [action] });
  const changed = ['copper', 'core'].filter(name => artifacts[name].sha256 !== previousArtifacts[name].sha256);
  if (!changed.length) throw new Error('No contract changes to deploy');
  const upgrade = {
    ...common, phase: 'upgrade', description: 'Pause Core, upgrade ' + changed.join(' and ') + ', then verify the finalized deployment.',
    ...(feature ? { feature } : {}),
    previousArtifacts: Object.fromEntries(['copper', 'core'].map(name => [name, { sha256: previousArtifacts[name].sha256 }])),
    batches: [
      batch('core', call('set_paused', { paused: true })),
      ...changed.map(name => batch(name, call('upgrade', { wasm: binaries[name].toString('base64') }, '200000000000000'))),
    ],
  };
  const unpause = {
    ...common, phase: 'unpause', requiresUpgradeDigest: planDigest(upgrade),
    description: 'Unpause Core after the matching upgrade manifest has passed finalized code and state verification.',
    batches: [batch('core', call('set_paused', { paused: false }))],
  };
  return { upgrade, unpause };
}

function actionMatches(planned, actual) {
  if (planned.type === 'CreateAccount') return actual === 'CreateAccount' || Object.hasOwn(actual, 'CreateAccount');
  if (planned.type === 'Transfer') return actual.Transfer?.deposit === planned.params.deposit;
  if (planned.type === 'DeployContract') return actual.DeployContract?.code === planned.params.code;
  if (planned.type === 'FunctionCall') {
    const action = actual.FunctionCall;
    if (!action || action.method_name !== planned.params.methodName ||
        String(action.deposit) !== String(planned.params.deposit) || String(action.gas) !== String(planned.params.gas)) return false;
    try {
      return JSON.stringify(canonical(JSON.parse(Buffer.from(action.args, 'base64').toString('utf8')))) ===
        JSON.stringify(canonical(planned.params.args));
    } catch { return false; }
  }
  if (planned.type === 'AddKey') {
    const key = actual.AddKey;
    const expected = planned.params.accessKey?.permission;
    if (expected === 'FullAccess') return key?.public_key === planned.params.publicKey && key.access_key?.permission === 'FullAccess';
    const permission = key?.access_key?.permission?.FunctionCall;
    return key?.public_key === planned.params.publicKey && permission &&
      permission.receiver_id === expected?.receiverId && permission.allowance === expected?.allowance &&
      JSON.stringify(permission.method_names) === JSON.stringify(expected?.methodNames);
  }
  return false;
}

export function receiptMatchesBatch(plan, index, receipt) {
  const result = receipt?.result;
  const batch = plan.batches[index];
  const transaction = result?.transaction;
  return Boolean(batch && result.final_execution_status === 'FINAL' && result.status &&
    Object.hasOwn(result.status, 'SuccessValue') && transaction?.signer_id === (batch.signerId ?? plan.rootAccountId) &&
    transaction.receiver_id === batch.receiverId &&
    Array.isArray(transaction.actions) && transaction.actions.length === batch.actions.length &&
    !result.receipts_outcome?.some(entry => entry.outcome?.status?.Failure) &&
    batch.actions.every((action, position) => actionMatches(action, transaction.actions[position])));
}

