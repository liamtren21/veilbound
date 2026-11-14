import { DatabaseSync } from 'node:sqlite';

export function openModeRepository(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS game_mode_state (scope TEXT PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS game_mode_rewards (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, reward TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS game_mode_rewards_account ON game_mode_rewards(account_id);
  `);
  const read = db.prepare('SELECT state FROM game_mode_state WHERE scope = ?');
  const write = db.prepare(`
    INSERT INTO game_mode_state (scope, state) VALUES (?, ?)
    ON CONFLICT(scope) DO UPDATE SET state = excluded.state
  `);
  const listRewards = db.prepare('SELECT reward FROM game_mode_rewards WHERE account_id = ? ORDER BY rowid');
  const insertReward = db.prepare('INSERT INTO game_mode_rewards VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING');
  const readReward = db.prepare('SELECT reward FROM game_mode_rewards WHERE id = ?');
  function grant({ accountId, mode, milestone, kind, itemId, evidenceId, earnedAt }) {
    const id = JSON.stringify([accountId, mode, milestone, kind, itemId]);
    const item = { id, accountId, mode, milestone, kind, itemId, evidenceId, earnedAt,
      scope: 'account', tradable: false, settlement: 'game-account' };
    insertReward.run(id, accountId, JSON.stringify(item));
    return JSON.parse(readReward.get(id).reward);
  }
  return {
    rewards(accountId) {
      return listRewards.all(accountId).map(row => JSON.parse(row.reward));
    },
    update(scope, callback) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const prior = read.get(scope)?.state;
        const { state, result } = callback(prior ? JSON.parse(prior) : undefined, grant);
        const serialized = JSON.stringify(state);
        if (serialized !== prior) write.run(scope, serialized);
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
