import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export function openSocialAuth(file, { issuer, clientId, redirectUri, clientSecret, now = Date.now,
  transport = fetch, keySet, provider = 'social' } = {}) {
  const domain = new URL(issuer);
  if (domain.protocol !== 'https:' || domain.pathname !== '/' || domain.search || domain.hash ||
      domain.username || domain.password || !clientId) throw new Error('invalid_social_configuration');
  const callback = new URL(redirectUri);
  if (callback.protocol !== 'https:' && callback.hostname !== '127.0.0.1' && callback.hostname !== 'localhost') {
    throw new Error('invalid_social_callback');
  }
  const google = provider === 'google';
  if (google && (domain.origin !== 'https://accounts.google.com' || !clientSecret)) {
    throw new Error('invalid_google_configuration');
  }
  const authorizationEndpoint = google ? new URL('/o/oauth2/v2/auth', domain) : new URL('authorize', domain);
  const tokenEndpoint = google ? new URL('https://oauth2.googleapis.com/token') : new URL('oauth/token', domain);
  const keys = keySet ?? createRemoteJWKSet(google ? new URL('https://www.googleapis.com/oauth2/v3/certs')
    : new URL('.well-known/jwks.json', domain));
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS social_attempts (state TEXT PRIMARY KEY, player TEXT, nonce TEXT NOT NULL,
      verifier TEXT NOT NULL, expires INTEGER NOT NULL, status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS social_identities (subject TEXT PRIMARY KEY, player TEXT NOT NULL UNIQUE);
  `);
  return {
    provider,
    linked(playerId) {
      return Boolean(db.prepare('SELECT 1 FROM social_identities WHERE player = ?').get(playerId));
    },
    begin(playerId = null) {
      const state = randomBytes(32).toString('base64url');
      const nonce = randomBytes(32).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      db.prepare('DELETE FROM social_attempts WHERE expires <= ?').run(now());
      db.prepare('INSERT INTO social_attempts VALUES (?, ?, ?, ?, ?, ?)').run(state, playerId, nonce, verifier, now() + 300000, 'pending');
      const url = new URL(authorizationEndpoint);
      url.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
        scope: 'openid profile email', state, nonce, code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
      return { state, authorizationUrl: url.toString() };
    },
    async complete({ state, code }, playerId = null) {
      if (typeof state !== 'string' || state.length > 128 || typeof code !== 'string' || code.length > 4096) throw new Error('invalid_social_callback');
      const attempt = db.prepare('SELECT * FROM social_attempts WHERE state = ?').get(state);
      if (!attempt || attempt.player !== playerId || attempt.expires <= now() || attempt.status !== 'pending') throw new Error('social_attempt_unavailable');
      db.prepare("UPDATE social_attempts SET status = 'exchanging' WHERE state = ? AND status = 'pending'").run(state);
      try {
        const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId,
          redirect_uri: redirectUri, code, code_verifier: attempt.verifier, ...(clientSecret ? { client_secret: clientSecret } : {}) });
        const response = await transport(tokenEndpoint, { method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15000) });
        if (!response.ok) {
          const failure = google ? await response.json().catch(() => null) : null;
          if (['invalid_grant', 'invalid_client', 'redirect_uri_mismatch'].includes(failure?.error)) {
            throw new Error('social_exchange_' + failure.error);
          }
          throw new Error('social_exchange_failed');
        }
        const token = await response.json();
        if (typeof token.id_token !== 'string' || token.id_token.length > 20000) throw new Error('social_token_missing');
        const { payload } = await jwtVerify(token.id_token, keys, {
          issuer: google ? ['https://accounts.google.com', 'accounts.google.com'] : domain.toString(), audience: clientId, algorithms: ['RS256'], currentDate: new Date(now()),
          maxTokenAge: '5 minutes', clockTolerance: google ? 30 : 0,
          requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
        });
        if (payload.nonce !== attempt.nonce || typeof payload.sub !== 'string' || payload.sub.length > 255 ||
            Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) throw new Error('invalid_social_identity');
        db.exec('BEGIN IMMEDIATE');
        try {
          const prior = db.prepare('SELECT player FROM social_identities WHERE subject = ?').get(payload.sub);
          if (prior && playerId && prior.player !== playerId) throw new Error('profile_conflict');
          const owner = prior?.player ?? playerId ?? randomUUID();
          const existing = db.prepare('SELECT subject FROM social_identities WHERE player = ?').get(owner);
          if (existing && existing.subject !== payload.sub) throw new Error('profile_conflict');
          db.prepare('INSERT OR IGNORE INTO social_identities VALUES (?, ?)').run(payload.sub, owner);
          db.prepare('DELETE FROM social_attempts WHERE state = ?').run(state);
          db.exec('COMMIT');
          return { playerId: owner, provider };
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      } catch (error) {
        db.prepare('DELETE FROM social_attempts WHERE state = ?').run(state);
        throw error;
      }
    },
    close() { db.close(); },
  };
}
