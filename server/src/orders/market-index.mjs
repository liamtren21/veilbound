import { DatabaseSync } from 'node:sqlite';

export function openMarketIndex(file, { coreId, economy, transport = fetch, now = Date.now }) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS published_orders (
      owner TEXT NOT NULL, order_id TEXT NOT NULL, transaction_hash TEXT NOT NULL,
      published_at INTEGER NOT NULL, PRIMARY KEY(owner, order_id)
    );`);
  const insert = db.prepare(`INSERT INTO published_orders VALUES (?, ?, ?, ?)
    ON CONFLICT(owner, order_id) DO NOTHING`);
  const count = db.prepare('SELECT count(*) AS total FROM published_orders WHERE owner = ?');
  return {
    async publish(owner, transactionHash) {
      if (typeof transactionHash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(transactionHash)) {
        throw new Error('INVALID_MARKET_TRANSACTION');
      }
      const response = await transport('https://test.rpc.fastnear.com', { method: 'POST',
        headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ jsonrpc: '2.0', id: 'publish-market-order', method: 'tx',
          params: { tx_hash: transactionHash, sender_account_id: owner, wait_until: 'FINAL' } }),
      });
      const { result, error } = await response.json();
      if (!response.ok || error || result?.final_execution_status !== 'FINAL' ||
          !result.status || !Object.hasOwn(result.status, 'SuccessValue') ||
          result.transaction?.hash !== transactionHash || result.transaction.receiver_id !== coreId || result.transaction.signer_id !== owner ||
          result.receipts_outcome?.some(receipt => receipt.outcome?.status?.Failure)) throw new Error('MARKET_TRANSACTION_UNVERIFIED');
      const actions = result.transaction.actions;
      const method = actions?.[0]?.FunctionCall?.method_name;
      if (!Array.isArray(actions) || actions.length !== 1 || !['place_market_order', 'place_shop_order'].includes(method)) {
        throw new Error('MARKET_TRANSACTION_UNVERIFIED');
      }
      let args;
      try { args = JSON.parse(Buffer.from(actions[0].FunctionCall.args, 'base64').toString()); }
      catch { throw new Error('MARKET_TRANSACTION_UNVERIFIED'); }
      if (method === 'place_shop_order') {
        const charter = await economy.artifact(args.token_id);
        if (charter.token.value?.owner_id !== owner || charter.artifact.value?.kind !== 'SHOP_CHARTER' ||
            charter.artifact.value.epoch !== args.expected_epoch) throw new Error('MARKET_TRANSACTION_UNVERIFIED');
        owner = charter.artifact.value.vault_id;
        args.token_id = args.item_id;
      }
      const snapshot = await economy.order(owner, args.order_id);
      const order = snapshot.value;
      if (!order || order.token_id !== args.token_id || order.side !== args.side || order.price !== args.price ||
          order.quantity !== args.quantity || order.expires_at_ns !== args.expires_at_ns ||
          order.cancelled || BigInt(order.remaining) === 0n || BigInt(order.expires_at_ns) <= BigInt(now()) * 1000000n) {
        throw new Error('MARKET_ORDER_CLOSED');
      }
      if (!db.prepare('SELECT 1 FROM published_orders WHERE owner = ? AND order_id = ?').get(owner, args.order_id) &&
          count.get(owner).total >= 100) throw new Error('MARKET_PUBLICATION_LIMIT');
      insert.run(owner, args.order_id, transactionHash, now());
      return { owner, orderId: args.order_id, ...snapshot };
    },
    async list() {
      const rows = db.prepare('SELECT * FROM published_orders ORDER BY published_at DESC LIMIT 50').all();
      const snapshots = [];
      for (const row of rows) {
        const snapshot = await economy.order(row.owner, row.order_id);
        if (!snapshot.value || snapshot.value.cancelled || BigInt(snapshot.value.remaining) === 0n ||
            BigInt(snapshot.value.expires_at_ns) <= BigInt(now()) * 1000000n) {
          db.prepare('DELETE FROM published_orders WHERE owner = ? AND order_id = ?').run(row.owner, row.order_id);
          continue;
        }
        snapshots.push({ owner: row.owner, orderId: row.order_id, transactionHash: row.transaction_hash, ...snapshot });
      }
      return { orders: snapshots, source: 'player-published-finalized-orders' };
    },
    close() { db.close(); },
  };
}
