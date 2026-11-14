const account = /^(?:[a-z0-9]+(?:[-_.][a-z0-9]+)*\.testnet|[a-f0-9]{64})$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,95}$/;

export function createShopSnapshotReader({ coreId, epoch, transport = fetch }) {
  if (!account.test(coreId) || !Number.isSafeInteger(epoch) || epoch < 0) throw new Error('invalid_shop_snapshot_configuration');
  async function rpc(method, params) {
    const response = await transport('https://test.rpc.fastnear.com', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'shop-snapshot', method, params }), signal: AbortSignal.timeout(15_000),
    });
    const data = await response.json();
    if (!response.ok || data.error || data.result?.error) throw new Error('shop_chain_unavailable');
    return data.result;
  }
  return async (accountId, itemIds) => {
    if (!account.test(accountId) || !Array.isArray(itemIds) || itemIds.length > 50 ||
        itemIds.some(id => typeof id !== 'string' || !identifier.test(id))) throw new Error('invalid_shop_snapshot');
    const { header } = await rpc('block', { finality: 'final' });
    const view = async (method, args) => {
      const result = await rpc('query', { request_type: 'call_function', account_id: coreId, method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'), block_id: header.hash });
      if (result.block_hash !== header.hash) throw new Error('shop_snapshot_mismatch');
      return JSON.parse(Buffer.from(result.result).toString());
    };
    const [balance, ...items] = await Promise.all([
      view('get_balance', { account_id: accountId }),
      ...itemIds.map(token_id => view('get_item_balance', { account_id: accountId, token_id })),
    ]);
    const stock = Object.fromEntries(itemIds.map((id, index) => {
      const amount = Number(items[index].available);
      if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('shop_inventory_exceeds_safe_range');
      return [id, amount];
    }));
    return { accountId, epoch, blockHash: header.hash, blockHeight: header.height,
      availableAtomic: balance.available, reservedAtomic: balance.reserved, stock };
  };
}
