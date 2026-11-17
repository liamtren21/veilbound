import { DatabaseSync } from 'node:sqlite';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { randomUUID, createHash, createPublicKey, verify } from 'node:crypto';
import { providers, transactions, utils } from 'near-api-js';
import { encodeBase58, walletPayload } from './wallet.mjs';

const issuer = 'https://login.testnet.fast-auth.com/';
const audience = 'auth0.jwt.fast-auth.testnet';
const testnetRpc = new providers.JsonRpcProvider({ url: 'https://test.rpc.fastnear.com' });
const coreId = 'core.vibebound.testnet';

export function openNearSocialAuth(file, { walletAuth, clientId, dailyLimit, sponsor,
  keySet = createRemoteJWKSet(new URL('.well-known/jwks.json', issuer)), now = Date.now,
  rpc = testnetRpc }) {
  if (!clientId || !Number.isSafeInteger(dailyLimit) || dailyLimit < 1 || typeof sponsor !== 'function') {
    throw new Error('Invalid NEAR Auth sponsor configuration');
  }
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS near_social_challenges (
      state TEXT PRIMARY KEY, player TEXT NOT NULL, wallet_player TEXT, proof TEXT NOT NULL, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS near_social_signers (player TEXT PRIMARY KEY, account TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS near_social_transactions (
      id TEXT PRIMARY KEY, player TEXT NOT NULL, bytes TEXT NOT NULL, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS near_social_usage (day INTEGER PRIMARY KEY, used INTEGER NOT NULL);`);
  function consume(table, id, player) {
    const column = table === 'near_social_challenges' ? 'state' : 'id';
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!db.prepare(`DELETE FROM ${table} WHERE ${column} = ? AND player = ? AND expires > ?`).run(id, player, now()).changes) {
        throw new Error('NEAR_SOCIAL_AUTH_FAILED');
      }
      const day = Math.floor(now() / 86400000);
      db.prepare('DELETE FROM near_social_usage WHERE day < ?').run(day);
      const usage = db.prepare('SELECT used FROM near_social_usage WHERE day = ?').get(day);
      if ((usage?.used ?? 0) >= dailyLimit) throw new Error('NEAR_SOCIAL_LIMIT');
      db.prepare('INSERT INTO near_social_usage VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET used = used + 1').run(day);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  async function verifiedPayload(token, expected) {
    const { payload } = await jwtVerify(token, keySet, {
      issuer, audience, algorithms: ['RS256'], requiredClaims: ['sub', 'iat', 'exp'], maxTokenAge: '5m',
    });
    const bytes = payload.fatxn;
    if (payload.azp !== clientId || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 256 ||
        !String(payload.scope ?? '').split(' ').includes('transaction:sign') ||
        !Array.isArray(bytes) || bytes.length !== expected.length ||
        bytes.some((value, i) => value !== expected[i])) throw new Error('NEAR_SOCIAL_AUTH_FAILED');
    return { request: { guard_id: 'jwt#' + issuer, sign_payload: bytes, algorithm: 'eddsa', verify_payload: token },
      path: 'jwt#' + issuer + '#' + payload.sub };
  }
  const account = player => db.prepare('SELECT account FROM near_social_signers WHERE player = ?').get(player)?.account;
  return {
    clientId,
    canSign(player) { return Boolean(player && account(player) && account(player) === walletAuth.accountForPlayer(player)); },
    async prepareTransaction(player, transaction) {
      if (!this.canSign(player)) throw new Error('NEAR_SOCIAL_LINK_REQUIRED');
      const signerId = account(player);
      const call = transaction?.actions?.[0];
      const { methodName, deposit, gas, args } = call?.params ?? {};
      const storage = methodName === 'fund_storage' && args?.account_id === signerId &&
        typeof deposit === 'string' && /^[1-9][0-9]{0,22}$/.test(deposit) &&
        BigInt(deposit) <= 16_600_000_000_000_000_000_000n && gas === '30000000000000';
      const claim = methodName === 'claim_reward' && args?.receipt?.account_id === signerId &&
        deposit === '0' && gas === '150000000000000';
      if (transaction?.receiverId !== coreId || transaction.network !== 'testnet' ||
          transaction.actions?.length !== 1 || call.type !== 'FunctionCall' || (!storage && !claim)) {
        throw new Error('NEAR_SOCIAL_TRANSACTION_UNAVAILABLE');
      }
      const publicKey = utils.PublicKey.fromString('ed25519:' + encodeBase58(Buffer.from(signerId, 'hex')));
      let access;
      try {
        access = await rpc.query({ request_type: 'view_access_key', finality: 'final',
          account_id: signerId, public_key: publicKey.toString() });
      } catch { throw new Error('NEAR_SOCIAL_ACCOUNT_NEEDS_TESTNEAR'); }
      if (access.permission !== 'FullAccess') throw new Error('NEAR_SOCIAL_ACCOUNT_NEEDS_TESTNEAR');
      const tx = transactions.createTransaction(signerId, publicKey, coreId, BigInt(access.nonce) + 1n,
        [transactions.functionCall(methodName, args, BigInt(gas), BigInt(deposit))],
        utils.serialize.base_decode(access.block_hash));
      const id = randomUUID();
      const bytes = Buffer.from(tx.encode());
      db.prepare('DELETE FROM near_social_transactions WHERE expires <= ?').run(now());
      db.prepare('INSERT INTO near_social_transactions VALUES (?, ?, ?, ?)').run(id, player, bytes.toString('base64'), now() + 300000);
      return { id, bytes: [...bytes], deposit };
    },
    async submitTransaction(player, { id, verifyPayload }) {
      if (!this.canSign(player) || typeof id !== 'string' || typeof verifyPayload !== 'string') throw new Error('NEAR_SOCIAL_LINK_REQUIRED');
      const row = db.prepare('SELECT bytes FROM near_social_transactions WHERE id = ? AND player = ? AND expires > ?')
        .get(id, player, now());
      if (!row) throw new Error('NEAR_SOCIAL_CHALLENGE_EXPIRED');
      const bytes = Buffer.from(row.bytes, 'base64');
      const { request, path } = await verifiedPayload(verifyPayload, bytes);
      consume('near_social_transactions', id, player);
      const signed = await sponsor(request, path);
      const key = Buffer.from(utils.PublicKey.fromString(signed.publicKey).data);
      const signature = Buffer.from(signed.signature, 'base64');
      const digest = createHash('sha256').update(bytes).digest();
      if (key.toString('hex') !== account(player) || signature.length !== 64 ||
          !verify(null, digest, createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519',
            x: key.toString('base64url') }, format: 'jwk' }), signature)) throw new Error('NEAR_SOCIAL_AUTH_FAILED');
      const transaction = transactions.Transaction.decode(bytes);
      const result = await rpc.sendTransaction(new transactions.SignedTransaction({ transaction,
        signature: new transactions.Signature({ keyType: 0, data: signature }) }));
      if (!result?.transaction?.hash || !Object.hasOwn(result.status ?? {}, 'SuccessValue') ||
          result.receipts_outcome?.some(receipt => receipt.outcome?.status?.Failure)) {
        throw new Error('NEAR_SOCIAL_TRANSACTION_FAILED');
      }
      return { transactionHash: result.transaction.hash };
    },
    challenge(player, walletPlayer = player) {
      const proof = walletAuth.challenge(walletPlayer);
      db.prepare('DELETE FROM near_social_challenges WHERE expires <= ?').run(now());
      db.prepare('INSERT INTO near_social_challenges VALUES (?, ?, ?, ?, ?)').run(
        proof.state, player, walletPlayer, JSON.stringify(proof), now() + 300000);
      return proof;
    },
    async complete({ state, verifyPayload }, player) {
      const denied = () => { throw new Error('NEAR_SOCIAL_AUTH_FAILED'); };
      if (!player || typeof state !== 'string' || typeof verifyPayload !== 'string') denied();
      const record = db.prepare('SELECT * FROM near_social_challenges WHERE state = ? AND player = ? AND expires > ?')
        .get(state, player, now());
      if (!record) denied();
      const proof = JSON.parse(record.proof);
      const { request, path } = await verifiedPayload(verifyPayload, walletPayload(proof));
      consume('near_social_challenges', state, player);
      const signed = await sponsor(request, path);
      const accountId = Buffer.from(utils.PublicKey.fromString(signed.publicKey).data).toString('hex');
      const identity = await walletAuth.verify({ state, accountId, ...signed }, record.wallet_player);
      db.prepare('INSERT OR REPLACE INTO near_social_signers VALUES (?, ?)').run(identity.playerId, accountId);
      return { ...identity, provider: 'near-auth' };
    },
    close() { db.close(); },
  };
}
