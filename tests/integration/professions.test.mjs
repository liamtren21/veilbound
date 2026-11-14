import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createGameServer } from '../../server/src/http.mjs';
import { openGuestSessions } from '../../server/src/auth/guest.mjs';
import { openProfessions } from '../../server/src/progression/professions.mjs';

test('profession progress requires an owned Expedition replay and preserves higher unlocks', async () => {
  let mode = 'practice';
  let region = 3;
  const runs = { verifyProgress(player) {
    return { accountId: 'player-one', mode, checkpoints: [{ region, node: 'boss' }],
      observations: [{ kind: 'checkpoint', node: 'boss' }, { kind: 'salve-heal' },
        { kind: 'encounter-clear', node: 'terraces-elite' }] };
  } };
  const professions = openProfessions(':memory:', { runs });
  try {
    await assert.rejects(professions.record('player-one', 'run'), /PROFESSION_EXPEDITION_REQUIRED/);
    mode = 'expedition';
    await assert.rejects(professions.record('other-player', 'run'), /PROFESSION_EXPEDITION_REQUIRED/);
    assert.deepEqual((await professions.record('player-one', 'run')).unlocked, ['apothecary', 'relicsmith']);
    assert.throws(() => professions.select('player-one', 'binder'), /PROFESSION_LOCKED/);
    professions.select('player-one', 'relicsmith');
    region = 1;
    const result = await professions.record('player-one', 'run');
    assert.equal(result.active, 'relicsmith');
    assert.equal(result.region, 3);
    assert.deepEqual(result.unlocked, ['apothecary', 'relicsmith']);
  } finally { professions.close(); }
});

test('checkpoint and verified specialty objective can be recorded separately and reused safely', async () => {
  const player = 'verified-player';
  const runs = { verifyProgress: (_player, runId) => ({
    accountId: player, mode: 'expedition',
    checkpoints: runId === 'clear' ? [{ region: 5, node: 'sunken-tribunal' }] : [],
    observations: runId === 'clear' ? [{ kind: 'checkpoint', node: 'sunken-tribunal' }]
      : [{ kind: 'salve-heal' }, { kind: 'encounter-clear', node: 'terraces-elite' }, { kind: 'remember-names', node: 'memorial' }],
  }) };
  const professions = openProfessions(':memory:', { runs });
  try {
    const locked = await professions.record(player, 'clear');
    assert.equal(locked.region, 5);
    assert.deepEqual(locked.unlocked, []);
    assert.throws(() => professions.select(player, 'binder'), /PROFESSION_LOCKED/);
    const done = await professions.record(player, 'objectives');
    assert.equal(done.region, 5);
    assert.deepEqual(done.unlocked, ['apothecary', 'relicsmith', 'binder']);
    assert.deepEqual(await professions.record(player, 'objectives'), done);
    assert.equal(professions.select(player, 'binder').active, 'binder');
    assert.equal(professions.select(player, 'apothecary').active, 'apothecary');
  } finally { professions.close(); }
});

test('specialty workshop preparation uses verified Expedition progress while public crafting remains open', async () => {
  const origin = 'http://veilbound.test';
  const sessions = openGuestSessions(':memory:');
  const professions = openProfessions(':memory:', {
    runs: { verifyProgress: player => ({
      accountId: player, mode: 'expedition', checkpoints: [{ region: 1, node: 'boss' }],
      observations: [{ kind: 'checkpoint', node: 'boss' }, { kind: 'salve-heal' },
        { kind: 'encounter-clear', node: 'terraces-elite' }],
    }) },
  });
  const prepared = [];
  const { token } = sessions.create();
  const server = createGameServer({
    origin, sessions, professions,
    walletAuth: { accountForPlayer: () => 'merchant.testnet' },
    economy: { prepareCraft(input) { prepared.push(input); return { receiverId: 'core.testnet' }; } },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const post = (path, input) => fetch('http://127.0.0.1:' + server.address().port + '/api/' + path, {
    method: 'POST', headers: { origin, cookie: 'veilbound_guest=' + token }, body: JSON.stringify(input),
  });
  const input = { recipeId: 'apothecary-ward-v1', operationId: 'craft-1' };
  try {
    const blocked = await post('economy/prepare-craft', { ...input, workshop: 'specialty' });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).error, 'PROFESSION_SPECIALTY_REQUIRED');
    assert.equal(prepared.length, 0);
    assert.equal((await post('economy/prepare-craft', { ...input, workshop: 'public' })).status, 200);
    assert.equal((await post('professions/record', { runId: 'expedition-1' })).status, 200);
    assert.equal((await post('professions/select', { specialty: 'apothecary' })).status, 200);
    assert.equal((await post('economy/prepare-craft', { ...input, workshop: 'specialty' })).status, 200);
    assert.equal(prepared.length, 2);
  } finally {
    await new Promise(resolve => server.close(resolve));
    sessions.close();
    professions.close();
  }
});
