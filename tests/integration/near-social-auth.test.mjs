import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { createLocalJWKSet, SignJWT } from '../../server/node_modules/jose/dist/webapi/index.js';
import { openGuestSessions } from '../../server/src/auth/guest.mjs';
import { encodeBase58, openWalletAuth, walletPayload } from '../../server/src/auth/wallet.mjs';
import { createGameServer } from '../../server/src/http.mjs';

test('NEAR Auth sponsors only the session-bound signed login payload and resumes the same profile', async () => {
  const { openNearSocialAuth } = await import('../../server/src/auth/near-social.mjs');
  const origin = 'http://veilbound.test';
  const issuer = 'https://login.testnet.fast-auth.com/';
  const audience = 'auth0.jwt.fast-auth.testnet';
  const clientId = 'test-client';
  const subject = 'google-oauth2|test';
  const oidc = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ed = generateKeyPairSync('ed25519');
  const rawKey = Buffer.from(ed.publicKey.export({ format: 'jwk' }).x, 'base64url');
  const publicKey = `ed25519:${encodeBase58(rawKey)}`;
  const accountId = rawKey.toString('hex');
  const sessions = openGuestSessions(':memory:');
  const walletAuth = openWalletAuth(':memory:', { recipient: 'veilbound.test', accessKeys: async () => ({ exists: false }) });
  let sponsored = 0;
  let broadcasts = 0;
  let expectedMethod = 'fund_storage';
  const deposit = '16600000000000000000000';
  const nearSocialAuth = openNearSocialAuth(':memory:', {
    walletAuth, clientId, dailyLimit: 4,
    rpc: {
      async query() { return { permission: 'FullAccess', nonce: 5, block_hash: '1'.repeat(32) }; },
      async sendTransaction(signed) {
        assert.equal(signed.transaction.signerId, accountId);
        assert.equal(signed.transaction.receiverId, 'core.vibebound.testnet');
        const { functionCall } = signed.transaction.actions[0];
        assert.equal(functionCall.methodName, expectedMethod);
        const storage = expectedMethod === 'fund_storage';
        assert.equal(String(functionCall.deposit), storage ? deposit : '1');
        const args = JSON.parse(Buffer.from(functionCall.args));
        assert.equal(storage ? args.account_id : args.receipt.account_id, accountId);
        broadcasts++;
        return { transaction: { hash: 'fixture-transaction' }, status: { SuccessValue: '' } };
      },
    },
    keySet: createLocalJWKSet({ keys: [{ ...oidc.publicKey.export({ format: 'jwk' }), kid: 'test', alg: 'RS256' }] }),
    sponsor: async ({ guard_id, sign_payload, algorithm }, path) => {
      assert.equal(guard_id, `jwt#${issuer}`);
      assert.equal(algorithm, 'eddsa');
      assert.equal(path, `jwt#${issuer}#${subject}`);
      sponsored++;
      return { publicKey, signature: sign(null, createHash('sha256').update(Buffer.from(sign_payload)).digest(), ed.privateKey).toString('base64') };
    },
  });
  const economy = { rewardStorage: async () => ({ deposit,
    transaction: { network: 'testnet', receiverId: 'core.vibebound.testnet', actions: [
      { type: 'FunctionCall', params: { methodName: 'fund_storage', deposit, gas: '30000000000000', args: { account_id: accountId } } },
    ] } }) };
  const runs = { async prepareBank(_player, runId, region) {
    assert.equal(runId, 'expedition-1');
    assert.equal(region, 1);
    return { transaction: { network: 'testnet', receiverId: 'core.vibebound.testnet', actions: [
      { type: 'FunctionCall', params: { methodName: 'claim_reward', deposit: '1', gas: '150000000000000',
        args: { receipt: { account_id: accountId }, signature: 'fixture' } } },
    ] } };
  } };
  const server = createGameServer({ sessions, walletAuth, nearSocialAuth, economy, runs, origin, secureCookies: false });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (path, cookie, body) => fetch(base + path, {
    method: 'POST', headers: { origin, ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  const cookieOf = response => response.headers.get('set-cookie').split(';')[0];
  const complete = (cookie, body) => post('/api/auth/near/complete', cookie, body);
  const challenge = cookie => post('/api/auth/near/challenge', cookie);
  const jwt = (payload, claims = {}) => new SignJWT({ fatxn: [...payload], azp: clientId, scope: 'openid transaction:sign', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(issuer).setAudience(audience).setSubject(subject)
    .setIssuedAt().setExpirationTime('1m').sign(oidc.privateKey);
  try {
    const guest = await post('/api/guest');
    const cookie = cookieOf(guest);
    const { playerId } = await guest.json();
    const otherCookie = cookieOf(await post('/api/guest'));
    const proof = await (await challenge(cookie)).json();
    const verifyPayload = await jwt(walletPayload(proof));
    assert.equal((await complete(otherCookie, { state: proof.state, verifyPayload })).status, 401);
    assert.equal((await complete(cookie, { state: proof.state, verifyPayload: await jwt(Buffer.from([5])) })).status, 401);
    assert.equal((await complete(cookie, { state: proof.state, verifyPayload: await jwt(walletPayload(proof), { azp: 'wrong' }) })).status, 401);
    assert.equal(sponsored, 0);
    const concurrent = await Promise.all([complete(cookie, { state: proof.state, verifyPayload }), complete(cookie, { state: proof.state, verifyPayload })]);
    assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 401]);
    const success = concurrent.find(response => response.ok);
    assert.deepEqual(await success.json(), { playerId, accountId, provider: 'near-auth' });
    assert.notEqual(cookieOf(success), cookie);
    assert.equal((await complete(cookieOf(success), { state: proof.state, verifyPayload })).status, 401);
    assert.equal(sponsored, 1);

    const fresh = await challenge();
    const freshProof = await fresh.json();
    const resumed = await complete(cookieOf(fresh), { state: freshProof.state, verifyPayload: await jwt(walletPayload(freshProof)) });
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json()).playerId, playerId);
    assert.equal(walletAuth.accountForPlayer(playerId), accountId);
    assert.equal(sponsored, 2);
    const txRoute = '/api/auth/near/transaction';
    const linkedCookie = cookieOf(resumed);
    const draft = await (await post(txRoute, linkedCookie, {})).json();
    const payload = await jwt(draft.bytes);
    assert.equal((await post(txRoute, otherCookie, { id: draft.id, verifyPayload: payload })).status, 409);
    assert.equal((await post(txRoute, linkedCookie, { id: draft.id, verifyPayload: await jwt([0]) })).status, 409);
    assert.equal(sponsored, 2);
    const submitted = await post(txRoute, linkedCookie, { id: draft.id, verifyPayload: payload });
    assert.equal(submitted.status, 200, await submitted.clone().text());
    assert.deepEqual(await submitted.json(), { transactionHash: 'fixture-transaction' });
    assert.equal((await post(txRoute, linkedCookie, { id: draft.id, verifyPayload: payload })).status, 409);
    assert.equal(broadcasts, 1);
    expectedMethod = 'claim_reward';
    const reward = await (await post(txRoute, linkedCookie, { runId: 'expedition-1', region: 1 })).json();
    const rewardResult = await post(txRoute, linkedCookie, { id: reward.id, verifyPayload: await jwt(reward.bytes) });
    assert.equal(rewardResult.status, 200, await rewardResult.clone().text());
    assert.equal(broadcasts, 2);
  } finally {
    await new Promise(resolve => server.close(resolve));
    nearSocialAuth.close();
    walletAuth.close();
    sessions.close();
  }
});
