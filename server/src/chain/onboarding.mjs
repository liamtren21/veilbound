import { readFile } from 'node:fs/promises';
import { connect, keyStores, KeyPair } from 'near-api-js';

export async function createOnboardingChain({ rootAccountId, coreId, keyPath, keyValue }) {
  if (!/^[a-z0-9]+(?:[-_.][a-z0-9]+)*\.testnet$/.test(rootAccountId) || coreId !== 'core.' + rootAccountId) {
    throw new Error('invalid_onboarding_accounts');
  }
  if (Boolean(keyPath) === Boolean(keyValue)) throw new Error('configure_one_onboarding_key_source');
  const key = KeyPair.fromString((keyValue ?? await readFile(keyPath, 'utf8')).trim());
  const store = new keyStores.InMemoryKeyStore();
  await store.setKey('testnet', rootAccountId, key);
  const near = await connect({ networkId: 'testnet', nodeUrl: 'https://test.rpc.fastnear.com', keyStore: store });
  const account = await near.account(rootAccountId);
  const access = await account.connection.provider.query({
    request_type: 'view_access_key', account_id: rootAccountId, public_key: key.getPublicKey().toString(), finality: 'final',
  });
  const permission = access.permission?.FunctionCall;
  const methods = permission?.method_names;
  const settlement = methods?.includes('settle_starter_run');
  if (!permission || permission.receiver_id !== coreId || methods?.length !== (settlement ? 3 : 2) ||
      !['issue_starter', 'link_starter'].every(method => methods.includes(method)) ||
      typeof permission.allowance !== 'string' || !/^\d+$/.test(permission.allowance) ||
      BigInt(permission.allowance) > 100000000000000000000000n) throw new Error('onboarding_key_requires_scoped_permission');
  let queue = Promise.resolve();
  const invoke = (methodName, args) => {
    const next = queue.catch(() => {}).then(async () => {
      const result = await account.functionCall({ contractId: coreId, methodName, args,
        gas: 80000000000000n, attachedDeposit: 0n });
      if (!result.status || typeof result.status !== 'object' || !Object.hasOwn(result.status, 'SuccessValue') ||
          result.receipts_outcome?.some(receipt => receipt.outcome?.status?.Failure)) throw new Error('onboarding_transaction_failed');
      return { transactionHash: result.transaction.hash };
    });
    queue = next;
    return next;
  };
  async function view(method_name, args) {
    const result = await account.connection.provider.query({ request_type: 'call_function', account_id: coreId,
      method_name, args_base64: Buffer.from(JSON.stringify(args)).toString('base64'), finality: 'final' });
    return JSON.parse(Buffer.from(result.result).toString());
  }
  return {
    getFinalGrant: grant_id => view('get_starter_grant', { grant_id }),
    ...(settlement ? {
      getFinalInventory: grant_id => view('get_starter_inventory', { grant_id }),
      getFinalSpend: ({ grant_id, run_id }) => view('get_starter_run_spend', { grant_id, run_id }),
      settle: args => invoke('settle_starter_run', args),
    } : {}),
    issue: args => invoke('issue_starter', args),
    link: args => invoke('link_starter', args),
    claimTransaction(grantId) {
      return { network: 'testnet', receiverId: coreId, actions: [{ type: 'FunctionCall',
        params: { methodName: 'claim_starter', args: { grant_id: grantId }, gas: '100000000000000', deposit: '1' } }] };
    },
  };
}
