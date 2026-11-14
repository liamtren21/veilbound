import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function encodeBase58(bytes) {
  let value = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'));
  let result = '';
  while (value) { result = alphabet[Number(value % 58n)] + result; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; result = '1' + result; }
  return result;
}
function decodeKey(value) {
  if (typeof value !== 'string' || !value.startsWith('ed25519:')) throw new Error('invalid_public_key');
  const text = value.slice(8);
  if (text.length < 32 || text.length > 44) throw new Error('invalid_public_key');
  let number = 0n;
  for (const char of text) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error('invalid_public_key');
    number = number * 58n + BigInt(index);
  }
  let hex = number.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const zeros = text.match(/^1*/)[0].length;
  const bytes = Buffer.concat([Buffer.alloc(zeros), number ? Buffer.from(hex, 'hex') : Buffer.alloc(0)]);
  if (bytes.length !== 32) throw new Error('invalid_public_key');
  return bytes;
}
function borshString(value) {
  const bytes = Buffer.from(value);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(bytes.length);
  return Buffer.concat([size, bytes]);
}
export function walletPayload({ message, nonce, recipient, callbackUrl }) {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(2147484061);
  const nonceBytes = Buffer.from(nonce, 'base64');
  if (nonceBytes.length !== 32) throw new Error('invalid_nonce');
  return Buffer.concat([prefix, borshString(message), nonceBytes, borshString(recipient),
    Buffer.from([callbackUrl ? 1 : 0]), ...(callbackUrl ? [borshString(callbackUrl)] : [])]);
}

const walletRpcEndpoints = ['https://test.rpc.fastnear.com', 'https://testnet-rpc.intea.rs'];

export async function testnetAccessKeys(accountId, transport = fetch) {
  async function query(endpoint, requestType) {
    const response = await transport(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'auth', method: 'query',
        params: { request_type: requestType, account_id: accountId, finality: 'final' } }),
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) throw new Error('wallet_rpc_unavailable');
    return response.json();
  }
  for (const endpoint of walletRpcEndpoints) {
    try {
      const data = await query(endpoint, 'view_access_key_list');
      const keys = data.result?.keys;
      if (Array.isArray(keys) && (keys.length || !/^[a-f0-9]{64}$/.test(accountId))) return keys;
      if (/^[a-f0-9]{64}$/.test(accountId)) {
        const account = await query(endpoint, 'view_account');
        if (Array.isArray(keys) && account.result?.amount !== undefined) return keys;
        if (account.error?.cause?.name === 'UNKNOWN_ACCOUNT') return { exists: false };
      }
    } catch {
      // A transport failure is inconclusive. Try the next testnet RPC.
    }
  }
  throw new Error('wallet_rpc_unavailable');
}

export function openWalletAuth(file, { recipient, callbackUrl, now = Date.now, accessKeys = testnetAccessKeys }) {
  if (!recipient) throw new Error('wallet_recipient_required');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallet_challenges (id TEXT PRIMARY KEY, player TEXT, payload TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS wallet_identities (account TEXT PRIMARY KEY, player TEXT NOT NULL UNIQUE);
  `);
  return {
    accountForPlayer(playerId) {
      return db.prepare('SELECT account FROM wallet_identities WHERE player = ?').get(playerId)?.account ?? null;
    },
    challenge(playerId = null) {
      db.prepare('DELETE FROM wallet_challenges WHERE expires <= ?').run(now());
      const proof = { state: randomUUID(), nonce: randomBytes(32).toString('base64'),
        message: 'Sign in to VEILBOUND on NEAR testnet', recipient, ...(callbackUrl ? { callbackUrl } : {}) };
      db.prepare('INSERT INTO wallet_challenges VALUES (?, ?, ?, ?)').run(proof.state, playerId, JSON.stringify(proof), now() + 300000);
      return proof;
    },
    async verify(proof, playerId = null) {
      const unavailable = reason => {
        throw Object.assign(new Error('challenge_unavailable'), { reason });
      };
      if (typeof proof?.state !== 'string') unavailable('missing_state');
      const record = db.prepare('SELECT * FROM wallet_challenges WHERE id = ?').get(proof.state);
      if (!record) unavailable('state_not_found');
      if (record.expires <= now()) unavailable('state_expired');
      if (record.player !== playerId) unavailable('session_mismatch');
      const challenge = JSON.parse(record.payload);
      if (typeof proof.accountId !== 'string' || !/^(?:[a-z0-9]+(?:[-_.][a-z0-9]+)*\.testnet|[a-f0-9]{64})$/.test(proof.accountId) ||
          proof.accountId.length > 64) throw new Error('invalid_account');
      const bytes = decodeKey(proof.publicKey);
      if (typeof proof.signature !== 'string') throw new Error('invalid_signature');
      const signature = Buffer.from(proof.signature, 'base64');
      const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: bytes.toString('base64url') }, format: 'jwk' });
      const digest = createHash('sha256').update(walletPayload(challenge)).digest();
      if (signature.length !== 64 || !verify(null, digest, key, signature)) throw new Error('invalid_signature');
      const keys = await accessKeys(proof.accountId);
      const implicitMatch = keys?.exists === false && proof.accountId === bytes.toString('hex');
      if (!implicitMatch && (!Array.isArray(keys) ||
          !keys.some(entry => entry.public_key === proof.publicKey && entry.access_key?.permission === 'FullAccess'))) {
        throw new Error('wallet_key_unavailable');
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        const live = db.prepare('SELECT * FROM wallet_challenges WHERE id = ?').get(proof.state);
        if (!live || live.expires <= now()) unavailable('state_consumed_or_expired');
        const existing = db.prepare('SELECT player FROM wallet_identities WHERE account = ?').get(proof.accountId);
        if (playerId && existing && existing.player !== playerId) throw new Error('profile_conflict');
        const owner = existing?.player ?? playerId ?? randomUUID();
        const linked = db.prepare('SELECT account FROM wallet_identities WHERE player = ?').get(owner);
        if (linked && linked.account !== proof.accountId) throw new Error('profile_conflict');
        db.prepare('INSERT OR IGNORE INTO wallet_identities VALUES (?, ?)').run(proof.accountId, owner);
        db.prepare('DELETE FROM wallet_challenges WHERE id = ?').run(proof.state);
        db.exec('COMMIT');
        return { playerId: owner, accountId: proof.accountId };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { db.close(); },
  };
}
