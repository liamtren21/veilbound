import { DatabaseSync } from 'node:sqlite';

const empty = () => ({ runs: {}, progress: {}, startOperations: {} });

export function openSqliteRunRepository(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
  db.exec('CREATE TABLE IF NOT EXISTS game_run_accounts (account_id TEXT PRIMARY KEY, document TEXT NOT NULL)');
  const read = db.prepare('SELECT document FROM game_run_accounts WHERE account_id = ?');
  const write = db.prepare(`
    INSERT INTO game_run_accounts (account_id, document) VALUES (?, ?)
    ON CONFLICT(account_id) DO UPDATE SET document = excluded.document
  `);
  const get = accountId => JSON.parse(read.get(accountId)?.document ?? 'null') ?? empty();
  return {
    read(accountId, callback) {
      return callback(get(accountId));
    },
    update(accountId, callback) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const account = get(accountId);
        const result = callback(account);
        write.run(accountId, JSON.stringify(account));
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close: () => db.close(),
  };
}

export function createPostgresRunRepository(pool) {
  return {
    async read(accountId, callback) {
      const { rows } = await pool.query('SELECT document FROM game_run_accounts WHERE account_id = $1', [accountId]);
      return callback(rows[0]?.document ?? empty());
    },
    async update(accountId, callback) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [accountId]);
        const { rows } = await client.query('SELECT document FROM game_run_accounts WHERE account_id = $1', [accountId]);
        const account = rows[0]?.document ?? empty();
        const result = callback(account);
        await client.query(`
          INSERT INTO game_run_accounts (account_id, document) VALUES ($1, $2::jsonb)
          ON CONFLICT(account_id) DO UPDATE SET document = EXCLUDED.document
        `, [accountId, JSON.stringify(account)]);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

