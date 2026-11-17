import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connect, KeyPair, keyStores } from 'near-api-js';
import { createCoreClient } from '../chain/core.mjs';

export async function createLocalNpcSigner({ accountId, coreId, policy }) {
  if (!/^(provisioner|cursekeeper|relicsmith|quartermaster)\.vibebound\.testnet$/.test(accountId) ||
      coreId !== 'core.vibebound.testnet') throw new Error('unexpected_npc_signer_scope');

  const keyPath = join(homedir(), '.codex', 'secrets', 'veilbound', 'testnet-' + accountId + '.key');
  const key = KeyPair.fromString((await readFile(keyPath, 'utf8')).trim());
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey('testnet', accountId, key);
  const near = await connect({ networkId: 'testnet', nodeUrl: 'https://test.rpc.fastnear.com', keyStore });
  const account = await near.account(accountId);
  const core = createCoreClient({ coreId, copperId: 'copper.vibebound.testnet' });
  const access = await account.connection.provider.query({
    request_type: 'view_access_key', account_id: accountId,
    public_key: key.getPublicKey().toString(), finality: 'final',
  });
  if (access.permission !== 'FullAccess') throw new Error('npc_operating_key_unavailable');

  return async function signOrder(request) {
    const { transaction, operationId } = request;
    const { actions } = transaction;
    const action = actions?.[0];
    const { methodName, args, gas, deposit } = action?.params ?? {};
    if (request.accountId !== accountId || transaction.network !== 'testnet' ||
        transaction.receiverId !== coreId || actions?.length !== 1 ||
        action.type !== 'FunctionCall' || gas !== '100000000000000' || deposit !== '1' ||
        !/^npc-[0-9a-f]{60}$/.test(operationId) || args?.order_id !== operationId) {
      throw new Error('npc_signer_order_outside_scope');
    }
    if (methodName === 'cancel_market_order') {
      if (Object.keys(args).length !== 1) throw new Error('npc_signer_order_outside_scope');
      const { value: order } = await core.order(accountId, operationId);
      if (order?.side !== 'Buy' || BigInt(order.expires_at_ns) > BigInt(Date.now()) * 1000000n) {
        throw new Error('npc_signer_order_outside_policy');
      }
    } else {
      if (methodName !== 'place_market_order' || args.side !== 'Buy' || !policy.itemIds.includes(args.token_id) ||
          !/^[1-9]\d{0,18}$/.test(args.quantity) || !/^[1-9]\d{0,18}$/.test(args.price) ||
          !/^[1-9]\d{0,19}$/.test(args.expires_at_ns)) throw new Error('npc_signer_order_outside_scope');
      const quantity = BigInt(args.quantity);
      const price = BigInt(args.price);
      const expiry = BigInt(args.expires_at_ns);
      if (quantity > BigInt(policy.maxQuantity) || price > BigInt(policy.maxUnitPriceAtomic) ||
          quantity * price > BigInt(policy.budgetRemainingAtomic) ||
          expiry <= BigInt(Date.now()) * 1000000n || expiry > BigInt(policy.expiresAt) * 1000000n) {
        throw new Error('npc_signer_order_outside_policy');
      }
    }
    const result = await account.functionCall({
      contractId: coreId, methodName, args, gas: 30000000000000n, attachedDeposit: BigInt(deposit),
    });
    if (!Object.hasOwn(result.status ?? {}, 'SuccessValue') ||
        result.receipts_outcome?.some(receipt => receipt.outcome?.status?.Failure)) {
      throw new Error('npc_order_transaction_failed');
    }
    return { transactionHash: result.transaction.hash };
  };
}
