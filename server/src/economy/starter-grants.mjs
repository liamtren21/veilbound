import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

export function openStarterGrants(file, { chain, relicIds = [], now = Date.now, cacheTtlMs = 300_000 } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS guest_starter_jobs (
      player TEXT PRIMARY KEY, grant_id TEXT NOT NULL UNIQUE,
      relic_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, linked_account TEXT, confirmed_at INTEGER
    );
  `);
  if (!db.prepare('PRAGMA table_info(guest_starter_jobs)').all().some(column => column.name === 'confirmed_at')) {
    db.exec('ALTER TABLE guest_starter_jobs ADD COLUMN confirmed_at INTEGER');
  }
  if (!db.prepare('PRAGMA table_info(guest_starter_jobs)').all().some(column => column.name === 'inventory')) {
    db.exec('ALTER TABLE guest_starter_jobs ADD COLUMN inventory TEXT');
  }
  db.exec('COMMIT');
  const read = player => db.prepare('SELECT * FROM guest_starter_jobs WHERE player = ?').get(player);
  function status(row) {
    if (row?.status === 'claimed') return {
      grantId: row.grant_id, relicId: row.relic_id, status: 'claimed', custody: 'player',
    };
    if (row?.status === 'issued' && row.confirmed_at !== null && now() - row.confirmed_at < cacheTtlMs) {
      return {
        grantId: row.grant_id, relicId: row.relic_id, status: 'issued', custody: 'game',
        ...(!row.linked_account && row.inventory ? { inventory: JSON.parse(row.inventory) } : {}),
      };
    }
    return { status: 'pending', ...(row ? { grantId: row.grant_id } : {}) };
  }
  const queues = new Map();
  async function lock(player, work) {
    const previous = queues.get(player) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(work);
    queues.set(player, result);
    try { return await result; }
    finally { if (queues.get(player) === result) queues.delete(player); }
  }
  async function confirmed(row) {
    const grant = await chain.getFinalGrant(row.grant_id);
    if (!grant || grant.relic_id !== row.relic_id || (row.status === 'claimed' && !grant.claimed)) {
      db.prepare('UPDATE guest_starter_jobs SET confirmed_at = NULL WHERE player = ?').run(row.player);
      return null;
    }
    let inventory = null;
    if (!grant.claimed && !grant.linked_account && chain.getFinalInventory) {
      try { inventory = await chain.getFinalInventory(row.grant_id); }
      catch { /* Keep confirmed Relic custody available during an inventory read failure. */ }
    }
    db.prepare(`UPDATE guest_starter_jobs SET status = ?, confirmed_at = ?, inventory = ?,
      linked_account = COALESCE(linked_account, ?) WHERE player = ?`)
      .run(grant.claimed ? 'claimed' : 'issued', now(), inventory ? JSON.stringify(inventory) : null,
        grant.linked_account ?? null, row.player);
    return { grantId: row.grant_id, relicId: row.relic_id, status: grant.claimed ? 'claimed' : 'issued',
      linkedAccount: grant.linked_account, custody: grant.claimed ? 'player' : 'game',
      ...(inventory ? { inventory } : {}) };
  }
  return {
    status: player => status(read(player)),
    canClaim: () => typeof chain?.link === 'function' && typeof chain?.claimTransaction === 'function',
    relicForRun(player) {
      const row = read(player);
      if (!chain || !row || row.linked_account || status(row).status !== 'issued') return null;
      return { grantId: row.grant_id, relicId: row.relic_id, custody: 'game' };
    },
    inventoryForRun(player) {
      const row = read(player);
      if (!chain?.settle || !row?.inventory || row.linked_account || status(row).status !== 'issued') return null;
      return JSON.parse(row.inventory);
    },
    settleRun(player, receipt) {
      return lock(player, async () => {
        const row = read(player);
        if (!chain?.settle || row?.grant_id !== receipt.grant_id) throw new Error('starter_settlement_unavailable');
        const assertReceipt = value => {
          if (value.copper !== receipt.copper || !Array.isArray(value.quantities) ||
            value.quantities.length !== receipt.quantities.length ||
            value.quantities.some((amount, index) => amount !== receipt.quantities[index])) {
            throw new Error('starter_spend_payload_mismatch');
          }
        };
        let final = await chain.getFinalSpend(receipt);
        if (!final) {
          try { await chain.settle(receipt); }
          catch { /* A failed response may still have reached finality. */ }
          final = await chain.getFinalSpend(receipt);
          if (!final) throw new Error('starter_settlement_pending');
        }
        assertReceipt(final);
        const inventory = await chain.getFinalInventory(row.grant_id);
        if (!inventory) throw new Error('starter_inventory_pending');
        db.prepare('UPDATE guest_starter_jobs SET inventory = ?, confirmed_at = ? WHERE player = ?')
          .run(JSON.stringify(inventory), now(), player);
        return inventory;
      });
    },
    hasGrant(player) {
      const row = read(player);
      return Boolean(chain && row && ['issued', 'claimed'].includes(row.status));
    },
    async refreshStatus(player) {
      return lock(player, async () => {
        const row = read(player);
        if (!row) return { status: 'pending' };
        if (chain) {
          try { return await confirmed(row) ?? status(read(player)); }
          catch { return status(read(player)); }
        }
        return status(row);
      });
    },
    async provision(player) {
      if (typeof player !== 'string' || !/^[\w-]{1,100}$/.test(player)) throw new Error('invalid_player');
      return lock(player, async () => {
        if (!chain) return { status: 'pending', reason: 'chain_not_configured' };
        let row = read(player);
        if (!row) {
          db.exec('BEGIN IMMEDIATE');
          try {
            row = read(player);
            if (!row) {
              const used = new Set(db.prepare('SELECT relic_id FROM guest_starter_jobs').all().map(x => x.relic_id));
              const relic = relicIds.find(id => !used.has(id));
              if (!relic) {
                db.exec('COMMIT');
                return { status: 'pending', reason: 'starter_pool_empty' };
              }
              const grantId = createHash('sha256').update('veilbound-starter:' + player).digest('hex');
              db.prepare(`INSERT INTO guest_starter_jobs (player, grant_id, relic_id, status)
                VALUES (?, ?, ?, ?)`).run(player, grantId, relic, 'pending');
              row = read(player);
            }
            db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); throw error; }
        }
        const existing = await confirmed(row);
        if (existing) return existing;
        await chain.issue({ grant_id: row.grant_id, relic_id: row.relic_id });
        return await confirmed(row) ?? { status: 'pending', grantId: row.grant_id };
      });
    },
    async prepareClaim(player, accountId) {
      return lock(player, async () => {
        const row = read(player);
        if (!row || !chain?.claimTransaction || !chain.link) throw new Error('starter_not_ready');
        const prior = await confirmed(row);
        if (!prior) throw new Error('starter_not_ready');
        if (row.linked_account && row.linked_account !== accountId) throw new Error('starter_link_conflict');
        if (prior.linkedAccount && prior.linkedAccount !== accountId) throw new Error('starter_link_conflict');
        if (prior.status === 'claimed') return prior;
        if (prior.linkedAccount === accountId) return { ...prior, transaction: chain.claimTransaction(row.grant_id) };
        // Account must come from the verified identity mapping at the API boundary.
        db.prepare('UPDATE guest_starter_jobs SET linked_account = ? WHERE player = ?').run(accountId, player);
        try { await chain.link({ grant_id: row.grant_id, account_id: accountId }); }
        catch { /* The transaction may have reached NEAR even if the RPC response failed. */ }
        for (const waitMs of [0, 300, 650, 1300, 2000]) {
          if (waitMs) await delay(waitMs);
          const linked = await confirmed(row).catch(() => null);
          if (linked?.linkedAccount === accountId) {
            return linked.status === 'claimed' ? linked
              : { ...linked, transaction: chain.claimTransaction(row.grant_id) };
          }
          if (linked?.linkedAccount) throw new Error('starter_link_conflict');
        }
        throw new Error('starter_link_pending');
      });
    },
    close() { db.close(); },
  };
}
