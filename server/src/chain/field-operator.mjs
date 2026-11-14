import { readFile } from 'node:fs/promises';
import { connect, keyStores, KeyPair } from 'near-api-js';

const methods = ['reserve_field_reward', 'pay_field_reward', 'release_field_reward'];
const allowanceLimit = 100_000_000_000_000_000_000_000n;

export async function createFieldOperator({ operatorId, coreId, keyPath }) {
  const key = KeyPair.fromString((await readFile(keyPath, 'utf8')).trim());
  const store = new keyStores.InMemoryKeyStore();
  await store.setKey('testnet', operatorId, key);
  const near = await connect({ networkId: 'testnet', nodeUrl: 'https://test.rpc.fastnear.com', keyStore: store });
  const account = await near.account(operatorId);
  const provider = account.connection.provider;
  const access = await provider.query({
    request_type: 'view_access_key', account_id: operatorId,
    public_key: key.getPublicKey().toString(), finality: 'final',
  });
  const permission = access.permission?.FunctionCall;
  if (permission?.receiver_id !== coreId || permission.method_names?.length !== methods.length ||
      !methods.every(method => permission.method_names.includes(method)) ||
      typeof permission.allowance !== 'string' || !/^\d+$/.test(permission.allowance) ||
      BigInt(permission.allowance) > allowanceLimit || BigInt(permission.allowance) === 0n) {
    throw new Error('field_operator_key_requires_scoped_permission');
  }
  async function view(method_name, args, blockId) {
    const data = await provider.query({
      request_type: 'call_function', account_id: coreId, method_name,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
      ...(blockId ? { block_id: blockId } : { finality: 'final' }),
    });
    return { value: JSON.parse(Buffer.from(data.result).toString()), blockHash: data.block_hash };
  }
  const operator = await view('get_field_reward_operator', {});
  if (operator.value !== operatorId || !operator.blockHash) throw new Error('field_operator_not_authorized');
  let queue = Promise.resolve();
  return {
    async readFinal(reservationId) {
      const { header } = await provider.block({ finality: 'final' });
      const result = await view('get_field_reward', { reservation_id: reservationId }, header.hash);
      if (result.blockHash !== header.hash || typeof header.timestamp_nanosec !== 'string') {
        throw new Error('field_final_snapshot_unavailable');
      }
      return { ...result, finalizedAtNs: header.timestamp_nanosec };
    },
    signAndSend({ signerId, transaction }) {
      const [action] = transaction.actions;
      const params = action?.params;
      if (signerId !== operatorId || transaction.receiverId !== coreId || transaction.network !== 'testnet' ||
          transaction.actions.length !== 1 || action?.type !== 'FunctionCall' || !methods.includes(params.methodName) ||
          params.deposit !== '0' || params.gas !== '60000000000000') throw new Error('field_operator_transaction_unavailable');
      const next = queue.catch(() => {}).then(async () => {
        const result = await account.functionCall({
          contractId: coreId, methodName: params.methodName, args: params.args,
          gas: 60000000000000n, attachedDeposit: 0n,
        });
        if (!result.status || typeof result.status !== 'object' || !Object.hasOwn(result.status, 'SuccessValue') ||
            result.receipts_outcome?.some(receipt => receipt.outcome?.status?.Failure)) throw new Error('field_operator_transaction_failed');
        return { transactionHash: result.transaction.hash };
      });
      queue = next;
      return next;
    },
  };
}

