import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { connect, keyStores, KeyPair } from '../server/node_modules/near-api-js/lib/index.js';
import { createFieldOperator } from '../server/src/chain/field-operator.mjs';

const directory = 'deployments/field-rewards';
const plan = JSON.parse(await readFile(directory + '/testnet.field-operator.unsigned.json', 'utf8'));
const { core, copper, operator } = plan.contracts;
if (plan.network !== 'testnet' || operator !== 'field.vibebound.testnet') throw new Error('Unexpected Field setup plan');
import { resolve as resolveSecretDirectory } from 'node:path';
const secretDirectory = process.env.VEILBOUND_SECRETS_DIR ?? resolveSecretDirectory('.veilbound-secrets');
const key = KeyPair.fromString((await readFile(secretDirectory + '/testnet-field-setup.key', 'utf8')).trim());
if (key.getPublicKey().toString() !== plan.setupPublicKey) throw new Error('Field setup key differs');
const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey('testnet', operator, key);
const near = await connect({ networkId: 'testnet', nodeUrl: 'https://test.rpc.fastnear.com', keyStore });
const account = await near.account(operator);
const provider = account.connection.provider;
async function view(contractId, methodName, args) {
  const result = await provider.query({ request_type: 'call_function', account_id: contractId,
    method_name: methodName, args_base64: Buffer.from(JSON.stringify(args)).toString('base64'), finality: 'final' });
  return JSON.parse(Buffer.from(result.result).toString());
}
await createFieldOperator({ operatorId: operator, coreId: core, keyPath: secretDirectory + '/testnet-field-operator.key' });
const keys = await provider.query({ request_type: 'view_access_key_list', account_id: operator, finality: 'final' });
if (!keys.keys.some(row => row.public_key === plan.recoveryPublicKey && row.access_key.permission === 'FullAccess')) {
  throw new Error('Owner recovery key is missing');
}
if (await view(core, 'is_paused', {}) !== false) throw new Error('Core must be active');
const proof = { network: 'testnet', operator, steps: [] };
async function invoke(contractId, methodName, args, attachedDeposit) {
  const gas = methodName === 'fund_storage' ? 30000000000000n : 80000000000000n;
  const result = await account.functionCall({ contractId, methodName, args, gas,
    attachedDeposit: BigInt(attachedDeposit) });
  if (!result.status || !Object.hasOwn(result.status, 'SuccessValue') ||
      result.receipts_outcome?.some(row => row.outcome?.status?.Failure)) throw new Error('Field setup transaction failed');
  await mkdir('evidence/testnet', { recursive: true });
  await writeFile('evidence/testnet/field-local-' + result.transaction.hash + '.json', JSON.stringify(result, null, 2));
  proof.steps.push({ methodName, hash: result.transaction.hash });
}
let deposit = await view(core, 'get_operation', { operation_id: 'field-deposit-v1', account_id: operator, kind: 'deposit' });
if (!deposit) {
  const wallet = await view(copper, 'ft_balance_of', { account_id: operator });
  if (wallet !== plan.copperAtomic) throw new Error('Expected exactly the approved Field capital');
  const credit = await view(core, 'get_storage_credit', { account_id: operator });
  const target = BigInt(plan.coreStorageYocto) - 1600000000000000000000n;
  if (BigInt(credit) < target) {
    const registration = BigInt(credit) === 0n ? 1600000000000000000000n : 0n;
    await invoke(core, 'fund_storage', {}, target - BigInt(credit) + registration);
  }
  await invoke(copper, 'ft_transfer_call', { receiver_id: core, amount: plan.copperAtomic,
    msg: JSON.stringify({ operation_id: 'field-deposit-v1' }) }, 1n);
  deposit = await view(core, 'get_operation', { operation_id: 'field-deposit-v1', account_id: operator, kind: 'deposit' });
}
if (deposit?.status !== 'settled' || deposit.amount !== plan.copperAtomic) throw new Error('Field deposit is not finalized');
const balance = await view(core, 'get_balance', { account_id: operator });
if (balance.available !== plan.copperAtomic || balance.reserved !== '0') throw new Error('Field capital allocation mismatch');
const access = await provider.query({ request_type: 'view_access_key_list', account_id: operator, finality: 'final' });
if (access.keys.some(row => row.public_key === plan.setupPublicKey)) {
  const result = await account.deleteKey(plan.setupPublicKey);
  if (!result.status || !Object.hasOwn(result.status, 'SuccessValue')) throw new Error('Setup key removal failed');
  proof.steps.push({ methodName: 'DeleteKey', hash: result.transaction.hash });
}
const finalKeys = await provider.query({ request_type: 'view_access_key_list', account_id: operator, finality: 'final' });
if (finalKeys.keys.some(row => row.public_key === plan.setupPublicKey)) throw new Error('Setup key removal not finalized');
proof.status = 'VERIFIED_READY';
proof.balance = balance;
proof.deposit = deposit;
proof.blockHash = finalKeys.block_hash;
proof.keys = finalKeys.keys.map(row => ({ publicKey: row.public_key, permission: row.access_key.permission }));
await writeFile(directory + '/testnet.field-operator.verified.json', JSON.stringify(proof, null, 2));
console.log(JSON.stringify({ status: proof.status, operator, balance }));
