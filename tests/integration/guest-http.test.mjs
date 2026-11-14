import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createGameServer } from '../../server/src/http.mjs';
import { openGuestSessions } from '../../server/src/auth/guest.mjs';
import { openRuns } from '../../server/src/runs/service.mjs';
import { openWalletAuth, encodeBase58, walletPayload } from '../../server/src/auth/wallet.mjs';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { openStarterGrants } from '../../server/src/economy/starter-grants.mjs';

test('HTTP guest creation and resume are scoped to the session cookie', async () => {
  const origin = 'http://veilbound.test';
  const sessions = openGuestSessions(':memory:');
  const runs = openRuns(':memory:');
  const server = createGameServer({ sessions, runs, origin });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const invalid = await fetch(base + '/api/guest', { method: 'POST' });
    assert.equal(invalid.status, 403);
    const created = await fetch(base + '/api/guest', { method: 'POST', headers: { origin } });
    assert.equal(created.status, 201);
    const setCookie = created.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly; SameSite=Strict;.*Secure/);
    const cookie = setCookie.split(';')[0];
    const { playerId } = await created.json();
    const resumed = await fetch(base + '/api/guest', { method: 'POST', headers: { origin, cookie } });
    assert.equal(resumed.status, 200);
    assert.deepEqual(await resumed.json(), { playerId });
    const run = await fetch(base + '/api/runs', {
      method: 'POST', headers: { origin, cookie }, body: JSON.stringify({ operationId: 'start-1' }),
    });
    assert.equal(run.status, 200);
    const snapshot = await run.json();
    assert.ok(snapshot.runId);
    const active = await fetch(base + '/api/runs/active', { headers: { cookie } });
    assert.deepEqual(await active.json(), snapshot);
    await fetch(base + '/api/logout', { method: 'POST', headers: { origin, cookie } });
    const revoked = await fetch(base + '/api/runs/active', { headers: { cookie } });
    assert.equal(revoked.status, 401);
  } finally {
    await new Promise(resolve => server.close(resolve));
    sessions.close();
    runs.close();
  }
});

test('Guest creation schedules backed starter provisioning and resume retains the same grant', async () => {
  const origin = 'http://veilbound.test';
  const sessions = openGuestSessions(':memory:');
  const grants = new Map();
  let issued = 0;
  const chain = {
    getFinalGrant: async id => grants.get(id),
    issue: async args => { issued++; grants.set(args.grant_id, { relic_id: args.relic_id, claimed: false, linked_account: null }); },
  };
  const starter = openStarterGrants(':memory:', { chain, relicIds: ['starter-001'] });
  const runs = openRuns(':memory:', { starter });
  const server = createGameServer({ sessions, runs, starter, origin, secureCookies: false });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const guest = await fetch(base + '/api/guest', { method: 'POST', headers: { origin } });
    const cookie = guest.headers.get('set-cookie').split(';')[0];
    const { playerId } = await guest.json();
    const status = await (await fetch(base + '/api/starter', { headers: { cookie } })).json();
    assert.equal(status.status, 'issued');
    assert.equal(status.relicId, 'starter-001');
    const started = await fetch(base + '/api/runs', { method: 'POST', headers: { origin, cookie },
      body: JSON.stringify({ operationId: 'starter-opening', starterRelic: { relicId: 'forged' } }) });
    assert.equal(started.status, 200);
    const run = await started.json();
    assert.deepEqual(run.state.starterRelic, {
      grantId: status.grantId, relicId: 'starter-001', custody: 'game', heroKey: 'mara', slot: 0,
    });
    const remove = await fetch(base + '/api/runs/' + run.runId + '/actions', { method: 'POST', headers: { origin, cookie },
      body: JSON.stringify({ operationId: 'remove-starter', expectedVersion: run.version,
        intent: { type: 'move-equipment', heroKey: 'mara', slot: 0 } }) });
    assert.equal(remove.status, 422);
    const resumed = await fetch(base + '/api/guest', { method: 'POST', headers: { origin, cookie } });
    assert.equal((await resumed.json()).playerId, playerId);
    await starter.provision(playerId);
    assert.equal(issued, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    starter.close(); sessions.close(); runs.close();
  }
});

test('HTTP wallet link rotates the Guest session and retains its active run', async () => {
  const origin = 'http://veilbound.test';
  const sessions = openGuestSessions(':memory:');
  const runs = openRuns(':memory:');
  const keys = generateKeyPairSync('ed25519');
  const publicKey = 'ed25519:' + encodeBase58(Buffer.from(keys.publicKey.export({ format: 'jwk' }).x, 'base64url'));
  const walletAuth = openWalletAuth(':memory:', { recipient: 'veilbound.test',
    accessKeys: async () => [{ public_key: publicKey, access_key: { permission: 'FullAccess' } }] });
  const economy = { balances: accountId => ({ accountId, available: '100' }) };
  const server = createGameServer({ sessions, runs, walletAuth, economy, origin, secureCookies: false });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (path, cookie, body) => fetch(base + path, { method: 'POST', headers: { origin, ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  try {
    const guest = await post('/api/guest');
    const cookie = guest.headers.get('set-cookie').split(';')[0];
    const { playerId } = await guest.json();
    const snapshot = await (await post('/api/runs', cookie, { operationId: 'first' })).json();
    assert.equal((await fetch(base + '/api/economy/balances', { headers: { cookie } })).status, 409);
    const challenge = await (await post('/api/auth/wallet/challenge', cookie)).json();
    const proof = { ...challenge, accountId: 'alice.testnet', publicKey,
      signature: sign(null, createHash('sha256').update(walletPayload(challenge)).digest(), keys.privateKey).toString('base64') };
    const linked = await post('/api/auth/wallet/verify', cookie, proof);
    assert.equal(linked.status, 200);
    assert.equal((await linked.json()).playerId, playerId);
    const nextCookie = linked.headers.get('set-cookie').split(';')[0];
    assert.notEqual(nextCookie, cookie);
    assert.equal((await fetch(base + '/api/runs/active', { headers: { cookie } })).status, 401);
    const resumed = await fetch(base + '/api/runs/active', { headers: { cookie: nextCookie } });
    assert.equal((await resumed.json()).runId, snapshot.runId);
    const balance = await fetch(base + '/api/economy/balances', { headers: { cookie: nextCookie } });
    assert.deepEqual(await balance.json(), { accountId: 'alice.testnet', available: '100' });
  } finally {
    await new Promise(resolve => server.close(resolve));
    sessions.close();
    runs.close();
    walletAuth.close();
  }
});
