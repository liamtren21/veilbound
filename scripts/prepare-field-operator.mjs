import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { KeyPair } from '../server/node_modules/near-api-js/lib/index.js';

const root = 'vibebound.testnet';
const core = 'core.' + root;
const copper = 'copper.' + root;
const operator = 'field.' + root;
import { resolve as resolveSecretDirectory } from 'node:path';
const secretDirectory = process.env.VEILBOUND_SECRETS_DIR ?? resolveSecretDirectory('.veilbound-secrets');
async function query(params) {
  const response = await fetch('https://test.rpc.fastnear.com', { method: 'POST',
    headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 'field-prepare', method: 'query', params: { ...params, finality: 'final' } }),
  });
  if (!response.ok) throw new Error('Field setup RPC unavailable');
  return response.json();
}
const active = JSON.parse(await readFile('deployments/field-rewards/testnet.unpause.verified.json', 'utf8'));
if (active.status !== 'VERIFIED_ACTIVE') throw new Error('Field upgrade must be active');
const receipt = JSON.parse(await readFile('evidence/testnet/unpause-0-' + active.transactionHash + '.json', 'utf8'));
const recoveryKey = receipt.result.transaction.public_key;
const access = await query({ request_type: 'view_access_key', account_id: root, public_key: recoveryKey });
if (access.result?.permission !== 'FullAccess') throw new Error('Expected owner wallet recovery key');
const existing = await query({ request_type: 'view_account', account_id: operator });
if (!existing.error || existing.error.cause?.name !== 'UNKNOWN_ACCOUNT') throw new Error('Operator account is already present or query failed');
const boundsResponse = await query({ request_type: 'call_function', account_id: copper,
  method_name: 'storage_balance_bounds', args_base64: 'e30=' });
if (!Array.isArray(boundsResponse.result?.result)) throw new Error('FT storage bounds unavailable');
const bounds = JSON.parse(Buffer.from(boundsResponse.result.result).toString());
await mkdir(secretDirectory, { recursive: true });
async function keyFile(name) {
  const path = secretDirectory + '/' + name;
  try { return KeyPair.fromString((await readFile(path, 'utf8')).trim()); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const key = KeyPair.fromRandom('ed25519');
    await writeFile(path, key.toString(), { flag: 'wx', mode: 0o600 });
    return key;
  }
}
const setupKey = await keyFile('testnet-field-setup.key');
const jobKey = await keyFile('testnet-field-operator.key');
const keyAction = (key, permission) => ({ type: 'AddKey', params: { publicKey: key, accessKey: { permission } } });
const call = (methodName, args, deposit = '0') => ({ type: 'FunctionCall', params: {
  methodName, args, deposit, gas: '150000000000000',
} });
const batch = (receiverId, actions) => ({ signerId: root, receiverId, actions });
const plan = {
  network: 'testnet', phase: 'field-operator', status: 'UNSIGNED', rootAccountId: root,
  contracts: { core, copper, operator },
  description: 'Create a Field operator with 0.18 testNEAR and move 25 existing Copper into its wallet. The owner wallet key retains recovery access. A temporary local setup key funds storage, deposits the Copper and then removes itself. The running backend uses only a key restricted to three Field methods with 0.1 testNEAR gas allowance.',
  setupPublicKey: setupKey.getPublicKey().toString(), operatorPublicKey: jobKey.getPublicKey().toString(),
  recoveryPublicKey: recoveryKey, copperAtomic: '2500', coreStorageYocto: '80000000000000000000000',
  batches: [
    batch(operator, [{ type: 'CreateAccount' }, { type: 'Transfer', params: { deposit: '180000000000000000000000' } },
      keyAction(recoveryKey, 'FullAccess'), keyAction(setupKey.getPublicKey().toString(), 'FullAccess'),
      keyAction(jobKey.getPublicKey().toString(), { receiverId: core,
        methodNames: ['reserve_field_reward', 'pay_field_reward', 'release_field_reward'],
        allowance: '100000000000000000000000' })]),
    batch(core, [call('withdraw', { operation_id: 'field-capital-v1', amount: '2500' }, '1')]),
    batch(copper, [call('storage_deposit', { account_id: operator, registration_only: true }, bounds.min),
      call('ft_transfer', { receiver_id: operator, amount: '2500', memo: 'Field Contract capital' }, '1')]),
    batch(core, [call('set_field_reward_operator', { operator_id: operator })]),
  ],
};
await writeFile('deployments/field-rewards/testnet.field-operator.unsigned.json', JSON.stringify(plan, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ operator, batches: plan.batches.length, copperAtomic: plan.copperAtomic,
  attachedYocto: String(180000000000000000000000n + BigInt(bounds.min) + 2n) }));
