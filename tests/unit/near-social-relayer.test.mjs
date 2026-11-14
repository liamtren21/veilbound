import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNearSocialSponsor } from '../../server/src/auth/near-social-relayer.mjs';

test('NEAR Auth uses the reference relayer and checks the final signing transaction on testnet', async () => {
  const relayerUrl = 'https://relayer.example/api/relayer/fast-auth';
  const signerId = 'relayer.testnet';
  const hash = '11111111111111111111111111111111';
  const guardId = 'jwt#https://login.testnet.fast-auth.com/';
  const path = `${guardId}#test-user`;
  const request = { guard_id: guardId, sign_payload: [1, 2], algorithm: 'eddsa', verify_payload: 'test-jwt' };
  const publicKey = 'ed25519:9gR58nUYNKPekGpPbgMerDL2WNvY8nPYWq53YeEKU4SS';
  const signature = Buffer.alloc(64, 25);
  const successValue = bytes => Buffer.from(JSON.stringify({ signature: [...bytes] })).toString('base64');
  let finalStatus = 'FINAL';
  let returnedSignature = signature;
  const sponsor = createNearSocialSponsor({ relayerUrl, transport: async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    if (String(url) === `${relayerUrl}/sign-tx`) {
      assert.deepEqual(body, request);
      return Response.json({ hash, result: { transaction: { hash, signer_id: signerId } } });
    }
    assert.equal(String(url), 'https://test.rpc.fastnear.com');
    if (body.method === 'query') {
      assert.equal(body.params.finality, 'final');
      assert.equal(body.params.account_id, 'v1.signer-prod.testnet');
      assert.equal(body.params.method_name, 'derived_public_key');
      assert.deepEqual(JSON.parse(Buffer.from(body.params.args_base64, 'base64')),
        { path, predecessor: 'fast-auth.testnet', domain_id: 1 });
      return Response.json({ result: { result: [...Buffer.from(JSON.stringify(publicKey))] } });
    }
    assert.equal(body.method, 'tx');
    assert.deepEqual(body.params, { tx_hash: hash, sender_account_id: signerId, wait_until: 'FINAL' });
    return Response.json({ result: { final_execution_status: finalStatus,
      transaction: { hash, signer_id: signerId, receiver_id: 'fast-auth.testnet', actions: [
        { FunctionCall: { method_name: 'sign', args: Buffer.from(JSON.stringify(request)).toString('base64') } },
      ] }, status: { SuccessValue: successValue(returnedSignature) } } });
  } });
  assert.deepEqual(await sponsor(request, path), { publicKey, signature: signature.toString('base64') });
  finalStatus = 'EXECUTED_OPTIMISTIC';
  await assert.rejects(sponsor(request, path), /near_auth_sign_failed/);
  finalStatus = 'FINAL';
  returnedSignature = Buffer.alloc(63);
  await assert.rejects(sponsor(request, path), /near_auth_sign_failed/);
});
