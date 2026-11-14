import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from '../../server/node_modules/jose/dist/webapi/index.js';
import { openSocialAuth } from '../../server/src/auth/social.mjs';

test('social PKCE verifies signed identity and preserves Guest without email-based merges', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  const now = 1800000000000;
  let nonce;
  const social = openSocialAuth(':memory:', { issuer: 'https://auth.veilbound.test/', clientId: 'game',
    redirectUri: 'http://localhost/auth/callback', now: () => now,
    keySet: createLocalJWKSet({ keys: [{ ...jwk, kid: 'test', alg: 'RS256' }] }),
    transport: async (_url, options) => {
      assert.ok(options.body.get('code_verifier'));
      const id_token = await new SignJWT({ nonce, email: 'shared@example.test' }).setProtectedHeader({ alg: 'RS256', kid: 'test' })
        .setIssuer('https://auth.veilbound.test/').setAudience('game').setSubject('google-oauth2|1')
        .setIssuedAt(now / 1000).setExpirationTime(now / 1000 + 60).sign(privateKey);
      return { ok: true, json: async () => ({ id_token }) };
    } });
  const begin = player => {
    const result = social.begin(player);
    const url = new URL(result.authorizationUrl);
    nonce = url.searchParams.get('nonce');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    return { state: result.state, code: 'one-time-code' };
  };
  try {
    const request = begin('guest-1');
    assert.equal((await social.complete(request, 'guest-1')).playerId, 'guest-1');
    await assert.rejects(social.complete(request, 'guest-1'), /social_attempt_unavailable/);
    assert.equal((await social.complete(begin(null))).playerId, 'guest-1');
    await assert.rejects(social.complete(begin('guest-2'), 'guest-2'), /profile_conflict/);
  } finally { social.close(); }
});
