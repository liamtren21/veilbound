import { isDeepStrictEqual } from 'node:util';
import { readFile } from 'node:fs/promises';
import { connect, KeyPair, keyStores, utils } from 'near-api-js';

const rpcUrl = 'https://test.rpc.fastnear.com';
const authContract = 'fast-auth.testnet';
const mpcContract = 'v1.signer-prod.testnet';
const txHashPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const accountPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export function createNearSocialSponsor({ relayerUrl, transport = fetch, submit }) {
  if (submit !== undefined && (typeof submit !== 'function' || relayerUrl)) {
    throw new Error('Choose one NEAR Auth relayer');
  }
  const endpoint = submit ? null : new URL(relayerUrl);
  if (endpoint && (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)) {
    throw new Error('Invalid VEILBOUND_NEAR_AUTH_RELAYER_URL');
  }
  if (endpoint) endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/sign-tx`;

  async function post(url, body, timeout) {
    const response = await transport(url, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw new Error('near_auth_sign_failed');
    return response.json();
  }

  async function rpc(method, params) {
    const { result, error } = await post(rpcUrl, { jsonrpc: '2.0', id: 'near-auth', method, params }, 20000);
    if (error || !result || result.error) throw new Error('near_auth_sign_failed');
    return result;
  }

  return async (request, path) => {
    // Resolve the MPC identity before asking the relayer to spend testnet gas.
    const key = await rpc('query', {
      request_type: 'call_function', finality: 'final', account_id: mpcContract, method_name: 'derived_public_key',
      args_base64: Buffer.from(JSON.stringify({ path, predecessor: authContract, domain_id: 1 })).toString('base64'),
    });
    const publicKey = JSON.parse(Buffer.from(key.result).toString('utf8'));
    if (typeof publicKey !== 'string' || !publicKey.startsWith('ed25519:') ||
        utils.PublicKey.fromString(publicKey).toString() !== publicKey) throw new Error('near_auth_sign_failed');

    const relay = submit ? await submit(request) : await post(endpoint, request, 45000);
    const { hash } = relay;
    const signer = relay.result?.transaction?.signer_id;
    if (typeof hash !== 'string' || !txHashPattern.test(hash) || relay.result?.transaction?.hash !== hash ||
        typeof signer !== 'string' || signer.length < 2 || signer.length > 64 || !accountPattern.test(signer)) {
      throw new Error('near_auth_sign_failed');
    }

    // The reference relay waits for optimistic execution. Read the final outcome independently.
    const result = await rpc('tx', { tx_hash: hash, sender_account_id: signer, wait_until: 'FINAL' });
    const tx = result.transaction;
    const call = tx?.actions?.[0]?.FunctionCall;
    if (result.final_execution_status !== 'FINAL' || tx?.hash !== hash || tx?.signer_id !== signer ||
        tx?.receiver_id !== authContract || tx?.actions?.length !== 1 || call?.method_name !== 'sign' ||
        typeof call.args !== 'string' || typeof result.status?.SuccessValue !== 'string') {
      throw new Error('near_auth_sign_failed');
    }
    const actualArgs = JSON.parse(Buffer.from(call.args, 'base64').toString('utf8'));
    const { signature } = JSON.parse(Buffer.from(result.status.SuccessValue, 'base64').toString('utf8'));
    if (!isDeepStrictEqual(actualArgs, request) || !Array.isArray(signature) || signature.length !== 64 ||
        signature.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new Error('near_auth_sign_failed');
    return { publicKey, signature: Buffer.from(signature).toString('base64') };
  };
}

export async function createLocalNearSocialSponsor({ accountId, keyPath }) {
  if (!/^relay\.[a-z0-9-]+\.testnet$/.test(accountId ?? '') || !keyPath) {
    throw new Error('Expected a dedicated testnet relayer account and local key file');
  }
  const key = KeyPair.fromString((await readFile(keyPath, 'utf8')).trim());
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey('testnet', accountId, key);
  const near = await connect({ networkId: 'testnet', nodeUrl: rpcUrl, keyStore });
  const account = await near.account(accountId);
  const access = await account.connection.provider.query({
    request_type: 'view_access_key', account_id: accountId,
    public_key: key.getPublicKey().toString(), finality: 'final',
  });
  if (access.permission !== 'FullAccess') throw new Error('NEAR Auth relayer key unavailable');
  let queue = Promise.resolve();
  return createNearSocialSponsor({
    submit(request) {
      const signing = queue.then(async () => {
        const result = await account.functionCall({
          contractId: authContract, methodName: 'sign', args: request,
          gas: 200000000000000n, attachedDeposit: 1n,
        });
        return { hash: result.transaction.hash, result };
      });
      queue = signing.catch(() => {});
      return signing;
    },
  });
}
