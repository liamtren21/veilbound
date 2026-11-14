import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { openWalletAuth, encodeBase58, walletPayload, testnetAccessKeys } from '../../server/src/auth/wallet.mjs';

test('wallet proof links a Guest once, resumes its identity, rejects replay and cross-profile takeover', async () => {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = 'ed25519:' + encodeBase58(keys.publicKey.export({ format: 'jwk' }).x ?
    Buffer.from(keys.publicKey.export({ format: 'jwk' }).x, 'base64url') : Buffer.alloc(32));
  const auth = openWalletAuth(':memory:', {
    recipient: 'veilbound.test', now: () => 100,
    accessKeys: async () => [{ public_key: publicKey, access_key: { permission: 'FullAccess' } }],
  });
  const proof = async player => {
    const challenge = auth.challenge(player);
    return { ...challenge, accountId: 'alice.testnet', publicKey,
      signature: sign(null, createHash('sha256').update(walletPayload(challenge)).digest(), keys.privateKey).toString('base64') };
  };
  try {
    const first = await proof('guest-a');
    assert.equal((await auth.verify(first, 'guest-a')).playerId, 'guest-a');
    await assert.rejects(auth.verify(first, 'guest-a'), /challenge_unavailable/);
    assert.equal((await auth.verify(await proof(null), null)).playerId, 'guest-a');
    await assert.rejects(auth.verify(await proof('guest-b'), 'guest-b'), /profile_conflict/);
    const invalid = await proof(null);
    invalid.signature = Buffer.alloc(64).toString('base64');
    await assert.rejects(auth.verify(invalid, null), /invalid_signature/);
  } finally { auth.close(); }
});


test('wallet key lookup uses a backup testnet RPC when the primary is rate limited', async () => {
  const calls = [];
  const keys = [{ public_key: 'example', access_key: { permission: 'FullAccess' } }];
  const result = await testnetAccessKeys('alice.testnet', async (url, request) => {
    calls.push(url);
    assert.equal(JSON.parse(request.body).params.finality, 'final');
    return calls.length === 1 ? new Response('', { status: 429 }) : Response.json({ result: { keys } });
  });
  assert.deepEqual(result, keys);
  assert.equal(new Set(calls).size, 2);
});

test('RPC failure does not authorize an unregistered implicit wallet', async () => {
  await assert.rejects(testnetAccessKeys('a'.repeat(64), async () => new Response('', { status: 503 })),
    /wallet_rpc_unavailable/);
});


test('empty finalized key lists verify account existence explicitly for implicit wallets', async () => {
  const account = 'a'.repeat(64);
  const requests = [];
  const outcome = await testnetAccessKeys(account, async (_url, request) => {
    const { params } = JSON.parse(request.body);
    requests.push(params.request_type);
    return Response.json(params.request_type === 'view_access_key_list'
      ? { result: { keys: [] } }
      : { error: { cause: { name: 'UNKNOWN_ACCOUNT' } } });
  });
  assert.deepEqual(outcome, { exists: false });
  assert.deepEqual(requests, ['view_access_key_list', 'view_account']);
});
