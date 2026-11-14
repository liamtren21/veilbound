import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

export function openLocalStarterChain(file) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS local_starter_grants (id TEXT PRIMARY KEY, relic TEXT NOT NULL, inventory TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS local_starter_spends (grant_id TEXT NOT NULL, run_id TEXT NOT NULL,
      receipt TEXT NOT NULL, PRIMARY KEY(grant_id, run_id));`);
  const grant = db.prepare('SELECT * FROM local_starter_grants WHERE id = ?');
  const spend = db.prepare('SELECT receipt FROM local_starter_spends WHERE grant_id = ? AND run_id = ?');
  const inventory = id => {
    const row = grant.get(id);
    return row ? JSON.parse(row.inventory) : null;
  };
  return {
    issue({ grant_id, relic_id }) {
      db.prepare('INSERT OR IGNORE INTO local_starter_grants VALUES (?, ?, ?)')
        .run(grant_id, relic_id, JSON.stringify({ copper: '1000', token_ids: ['salve', 'ward'], quantities: ['1', '1'] }));
    },
    getFinalGrant(id) {
      const row = grant.get(id);
      return row ? { relic_id: row.relic, claimed: false, linked_account: null } : null;
    },
    getFinalInventory: inventory,
    getFinalSpend({ grant_id, run_id }) {
      const row = spend.get(grant_id, run_id);
      return row ? JSON.parse(row.receipt) : null;
    },
    settle(receipt) {
      const { grant_id, run_id, copper, quantities } = receipt;
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = spend.get(grant_id, run_id);
        if (existing) {
          if (!isDeepStrictEqual(JSON.parse(existing.receipt), receipt)) throw new Error('starter_conflict');
        } else {
          const prior = inventory(grant_id);
          if (!prior || !Array.isArray(quantities) || quantities.length !== prior.quantities.length ||
              ![copper, ...quantities].every(amount => typeof amount === 'string' && /^\d{1,18}$/.test(amount))) {
            throw new Error('invalid_starter_spend');
          }
          const available = [prior.copper, ...prior.quantities].map(BigInt);
          const remaining = [copper, ...quantities].map((amount, index) => available[index] - BigInt(amount));
          if (remaining.some(amount => amount < 0n)) throw new Error('starter_insufficient_inventory');
          const [nextCopper, ...nextQuantities] = remaining.map(String);
          db.prepare('UPDATE local_starter_grants SET inventory = ? WHERE id = ?')
            .run(JSON.stringify({ ...prior, copper: nextCopper, quantities: nextQuantities }), grant_id);
          db.prepare('INSERT INTO local_starter_spends VALUES (?, ?, ?)').run(grant_id, run_id, JSON.stringify(receipt));
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close() { db.close(); },
  };
}
