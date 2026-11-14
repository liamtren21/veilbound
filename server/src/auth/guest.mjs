import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const hash = token => createHash('sha256').update(token).digest('hex');
const validToken = token => typeof token === 'string' && /^[\w-]{43}$/.test(token);

export function openGuestSessions(file, { clock = Date.now, ttlMs = 30 * 86400000 } = {}) {
  const database = new DatabaseSync(file);
  database.exec(`
    CREATE TABLE IF NOT EXISTS guest_sessions (
      token_hash TEXT PRIMARY KEY,
      player_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS guest_session_expiry ON guest_sessions(expires_at);
  `);
  const insert = database.prepare('INSERT INTO guest_sessions VALUES (?, ?, ?)');
  const lookup = database.prepare('SELECT player_id FROM guest_sessions WHERE token_hash = ? AND expires_at > ?');
  const remove = database.prepare('DELETE FROM guest_sessions WHERE token_hash = ?');
  const prune = database.prepare('DELETE FROM guest_sessions WHERE expires_at <= ?');
  function createForPlayer(playerId) {
    const now = clock();
    prune.run(now);
    const token = randomBytes(32).toString('base64url');
    insert.run(hash(token), playerId, now + ttlMs);
    return { token, playerId, maxAge: Math.floor(ttlMs / 1000) };
  }
  return {
    create() {
      return createForPlayer(randomUUID());
    },
    createForPlayer,
    read(token) {
      if (!validToken(token)) return null;
      return lookup.get(hash(token), clock())?.player_id ?? null;
    },
    revoke(token) {
      if (validToken(token)) remove.run(hash(token));
    },
    close() { database.close(); },
  };
}
