import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeeklyOath } from '../../server/src/modes/weekly.mjs';
import { createBreach } from '../../server/src/modes/raid.mjs';
import { migrateTrialProgress, settleTrial, availableTrials } from '../../server/src/progression/unlocks.mjs';
import { createVeilDuel, actInDuel, tickDuel, verifyDuelReplay } from '../../shared/pvp-rules.mjs';
import { createCoop, submitCoop, tickCoop } from '../../shared/coop-rules.mjs';
import { openGameModes } from '../../server/src/modes/service.mjs';
import { createRaidCombat } from '../../server/src/modes/raid-combat.mjs';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { openGuestSessions } from '../../server/src/auth/guest.mjs';
import { createGameServer } from '../../server/src/http.mjs';
import { enter, newRun } from '../../expedition-rules.mjs';
import { openRuns } from '../../server/src/runs/service.mjs';
import { expeditionModeCombat } from '../../server/src/modes/config.mjs';

function authority() {
  let serial = 0;
  const runs = new Map();
  return {
    startRun(accountId, spec) {
      const runId = String(++serial);
      runs.set(runId, { accountId, spec });
      return { runId };
    },
    verifyRun(accountId, runId) {
      const record = runs.get(runId);
      if (!record || record.accountId !== accountId || !record.result) throw new Error('run_unverified');
      return record.result;
    },
    complete(runId, result) { runs.get(runId).result = { ...result, replayId: runId }; },
  };
}

test('Weekly ranks best verified attempt, respects grace and grants one bounded milestone', () => {
  let now = 100;
  const combat = authority();
  const weekly = createWeeklyOath({ combat, now: () => now, week: {
    id: 'w1', seed: 12, ruleset: 'v1', startsAt: 100, endsAt: 200, graceMs: 10,
    roster: ['rook', 'mara', 'elian'], budget: 0, rewardSlots: 1, targetRounds: 6,
  } });
  const first = weekly.start('alice');
  assert.throws(() => weekly.settle('alice', first.runId), /unverified/);
  combat.complete(first.runId, { objective: true, rounds: 6, faints: 0, consumables: 0 });
  weekly.settle('alice', first.runId);
  const second = weekly.start('alice');
  const practice = weekly.start('alice', { practice: true });
  combat.complete(practice.runId, { objective: true, rounds: 1, faints: 0, consumables: 0 });
  assert.equal(weekly.settle('alice', practice.runId).ranked, false);
  now = 209;
  combat.complete(second.runId, { objective: true, rounds: 5, faints: 1, consumables: 1 });
  weekly.settle('alice', second.runId);
  assert.equal(weekly.board()[0].replayId, second.runId);
  assert.deepEqual(weekly.claim('alice'), weekly.claim('alice'));
  assert.throws(() => weekly.start('alice'), /closed/);
});

test('Trials migrate legacy progress and unlock only after qualifying clears', () => {
  let state = migrateTrialProgress({ talismans: { gate: { wins: 1, xp: 60, bestTrial: 11 } } });
  assert.equal(state.legacy.talismans.gate.bestTrial, 11);
  assert.deepEqual(availableTrials(state).map(trial => trial.id), ['accord-i']);
  state = settleTrial(state, { trialId: 'accord-i', outcome: 'lost', talisman: 'gate', replayId: 'loss' });
  assert.equal(availableTrials(state).length, 1);
  state = settleTrial(state, { trialId: 'accord-i', outcome: 'won', talisman: 'gate', replayId: 'win' });
  assert.equal(availableTrials(state).length, 2);
  assert.deepEqual(settleTrial(state, { trialId: 'accord-i', outcome: 'won', talisman: 'gate', replayId: 'win' }), state);
});

test('Breach settles 100 encounters with one personal entitlement per account and no negative HP', async () => {
  const combat = authority();
  const raid = createBreach({ combat, now: () => 100, event: {
    id: 'r1', startsAt: 0, endsAt: 1000, graceMs: 0, hp: 20, contributionCap: 8,
    personalThreshold: 4, rewardSlots: 2, ruleset: 'v1',
  } });
  const entries = Array.from({ length: 100 }, (_, index) => {
    const accountId = 'player-' + index;
    const entry = raid.start(accountId);
    combat.complete(entry.runId, { damage: 100, objectives: ['ward', 'ward'], rounds: 8, clear: true });
    return { accountId, entry };
  });
  const receipts = await Promise.all(entries.map(async ({ accountId, entry }) => raid.settle(accountId, entry.runId)));
  assert.equal(receipts.reduce((total, result) => total + result.contribution, 0), 20);
  assert.equal(receipts.filter(result => result.rewardId).length, 2);
  assert.equal(raid.status().remainingHp, 0);
  assert.deepEqual(raid.settle(entries[0].accountId, entries[0].entry.runId), receipts[0]);
});

test('Duel guards turn ownership, rejects stale actions and forfeits after consecutive timeouts', () => {
  let state = createVeilDuel({ id: 'match', players: ['alice', 'bob'], seed: 0, now: 0 });
  const actor = state.players[state.turn].id;
  const other = state.players[1 - state.turn].id;
  const nonce = state.nonce;
  assert.throws(() => actInDuel(state, other, { nonce, type: 'pass' }, 1), /turn/);
  state = actInDuel(state, actor, { nonce, type: 'pass' }, 1);
  assert.throws(() => actInDuel(state, other, { nonce, type: 'pass' }, 2), /stale/);
  for (let turn = 0; turn < 8 && state.phase !== 'finished'; turn++) state = tickDuel(state, state.deadline);
  assert.equal(state.reason, 'timeout_forfeit');
  assert.equal(verifyDuelReplay(JSON.parse(JSON.stringify(state))), true);
});

test('Co-op hides pending work, retains actor ownership and resolves timeout bot after restart', () => {
  let state = createCoop({ id: 'room', players: ['alice', 'bob', 'cat'], now: 0 });
  assert.throws(() => submitCoop(state, 'other', { nonce: state.nonce, type: 'strike' }, 1), /participant/);
  const action = { nonce: state.nonce, type: 'strike' };
  state = submitCoop(state, 'alice', action, 1);
  assert.deepEqual(submitCoop(state, 'alice', action, 2), state);
  state = tickCoop(JSON.parse(JSON.stringify(state)), state.deadline);
  assert.equal(state.round, 2);
  assert.deepEqual(state.timeline[0].actions.map(action => action.bot), [false, true, true]);
  assert.throws(() => submitCoop(state, 'alice', action, state.deadline - 1), /stale/);
});


test('Realtime rooms authenticate actors and restore locked actions across service reopen', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'veilbound-modes-'));
  const file = join(directory, 'modes.db');
  let service = openGameModes(file, { now: () => 100 });
  const create = (accountId, path, body = {}) => service.route({ method: 'POST', accountId, path: '/api/modes/' + path, body });
  try {
    const room = create('alice', 'coop');
    create('bob', 'coop/' + room.id + '/join');
    create('cat', 'coop/' + room.id + '/join');
    for (const id of ['alice', 'bob', 'cat']) create(id, 'coop/' + room.id + '/ready');
    create('alice', 'coop/' + room.id + '/act', { nonce: 0, type: 'strike' });
    service.close();
    service = openGameModes(file, { now: () => 110 });
    const path = '/api/modes/coop/' + room.id;
    const read = accountId => service.route({ method: 'GET', accountId, path });
    assert.equal(read('alice').actors[0].action, 'strike');
    assert.equal(read('bob').actors[0].action, undefined);
    assert.equal(read('bob').actors[0].locked, true);
    assert.throws(() => read('outsider'), /participant/);
    create('bob', 'coop/' + room.id + '/act', { nonce: 0, type: 'guard' });
    assert.equal(create('cat', 'coop/' + room.id + '/act', { nonce: 0, type: 'strike' }).round, 2);
  } finally {
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});



test('Breach combat derives damage and objectives by replaying accepted phase-aware actions', () => {
  const state = {};
  const combat = createRaidCombat(state);
  const { runId } = combat.startRun('alice', { mode: 'raid', seed: 1, variant: 'sealed' });
  assert.throws(() => combat.act('bob', runId, { version: 0, type: 'wardbreak' }), /entry/);
  assert.throws(() => combat.act('alice', runId, { version: 0, type: 'burst' }), /action/);
  for (const [version, type] of ['wardbreak', 'mark', 'protect', 'counter', 'counter', 'burst', 'burst', 'burst'].entries()) {
    const view = combat.view('alice', runId);
    if (view.phase === 'active') combat.act('alice', runId, { version, type });
  }
  const proof = combat.verifyRun('alice', runId);
  assert.equal(proof.clear, true);
  assert.ok(proof.damage > 0);
  assert.deepEqual(proof.objectives, ['ward', 'mark', 'protect', 'counter', 'core']);
  state[runId].current.damage++;
  assert.throws(() => combat.verifyRun('alice', runId), /mismatch/);
});



function waitForState(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error('expected websocket state'));
    }, 2_000);
    const handler = data => {
      const message = JSON.parse(data);
      if (predicate(message)) {
        ws.off('message', handler);
        clearTimeout(timeout);
        resolve(message);
      }
    };
    ws.on('message', handler);
  });
}

test('Two authenticated websocket peers alternate actions and reconnect to the same duel nonce', async () => {
  const origin = 'http://localhost:9876';
  const sessions = openGuestSessions(':memory:');
  const modes = openGameModes(':memory:', { now: () => 100 });
  const server = createGameServer({ sessions, runs: {}, modes, origin, secureCookies: false });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const clients = [];
  try {
    const alice = sessions.create();
    const bob = sessions.create();
    const post = async (player, path, body = {}) => {
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/modes/' + path, {
        method: 'POST', headers: { origin, cookie: 'veilbound_guest=' + player.token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const room = await post(alice, 'duel');
    await post(bob, 'duel/' + room.id + '/join');
    await post(alice, 'duel/' + room.id + '/ready');
    await post(bob, 'duel/' + room.id + '/ready');
    const connect = async player => {
      const ws = new WebSocket('ws://127.0.0.1:' + server.address().port + '/api/realtime/duel/' + room.id, {
        origin, headers: { cookie: 'veilbound_guest=' + player.token },
      });
      clients.push(ws);
      const initial = await waitForState(ws, message => message.type === 'state');
      return { ws, state: initial.state, accountId: player.playerId };
    };
    const peers = await Promise.all([connect(alice), connect(bob)]);
    const { state } = peers[0];
    assert.deepEqual(state, peers[1].state);
    const actor = peers.find(peer => peer.accountId === state.players[state.turn].id);
    const spectator = peers.find(peer => peer !== actor);
    const invalid = waitForState(spectator.ws, message => message.type === 'error');
    spectator.ws.send(JSON.stringify({ type: 'act', action: { nonce: state.nonce, type: 'pass' } }));
    assert.equal((await invalid).error, 'DUEL_TURN_OWNER');
    const accepted = waitForState(spectator.ws, message => message.type === 'state' && message.state.nonce === 1);
    actor.ws.send(JSON.stringify({ type: 'act', action: { nonce: state.nonce, type: 'pass' } }));
    const next = (await accepted).state;
    spectator.ws.close();
    await once(spectator.ws, 'close');
    const reconnect = await connect(spectator.accountId === alice.playerId ? alice : bob);
    assert.equal(reconnect.state.nonce, next.nonce);
    assert.deepEqual(reconnect.state.players, next.players);
  } finally {
    for (const client of clients) client.terminate();
    server.closeRealtime();
    await new Promise(resolve => server.close(resolve));
    modes.close();
    sessions.close();
  }
});

test('Breach route settles genuine server combat and blocks cross-account evidence', () => {
  const modes = openGameModes(':memory:', { now: () => 100, raid: {
    id: 'real-breach', startsAt: 0, endsAt: 1000, graceMs: 0, hp: 20, contributionCap: 8,
    personalThreshold: 4, rewardSlots: 1, ruleset: 'v1',
  } });
  const route = (method, path, body, accountId = 'alice') =>
    modes.route({ method, path: '/api/modes/raid/' + path, accountId, body });
  try {
    const { runId } = route('POST', 'start', {});
    assert.throws(() => route('POST', 'settle', { runId, damage: 50 }), /incomplete/);
    assert.throws(() => route('GET', runId + '/encounter', undefined, 'bob'), /entry_missing/);
    const sequence = ['wardbreak', 'mark', 'protect', 'counter', 'counter', 'burst', 'burst', 'burst'];
    for (const [version, type] of sequence.entries()) {
      if (route('GET', runId + '/encounter').phase === 'active') route('POST', runId + '/act', { version, type });
    }
    const receipt = route('POST', 'settle', { runId });
    assert.equal(receipt.contribution, 8);
    assert.ok(receipt.rewardId);
    assert.deepEqual(route('POST', 'settle', { runId }), receipt);
    assert.equal(route('GET', 'status').remainingHp, 12);
  } finally {
    modes.close();
  }
});




test('Accord modifiers alter elite, boss and opening supplies without stacking legacy Trials', () => {
  const trial = {
    id: 'accord-iii', eliteVariant: 'fractured-ward', bossVariant: 'second-reckoning', recoveryPercent: 50, supportChoice: true,
  };
  const standard = newRun(1, { runId: 'standard' });
  const challenge = newRun(1, { runId: 'trial', trial: 11, accordTrial: trial, accordSupport: 'bark-shield' });
  for (const run of [standard, challenge]) {
    run.phase = 'map';
    run.node = 'cache';
    assert.equal(enter(run, 'graft'), true);
  }
  assert.equal(challenge.trial, 0);
  assert.deepEqual(challenge.pack.equipment, ['bark-shield']);
  assert.equal(challenge.battle.enemies[0].hp, standard.battle.enemies[0].hp);
  assert.equal(challenge.battle.enemies[0].ward, standard.battle.enemies[0].ward + 4);
  assert.equal(challenge.battle.enemies[0].guard, true);
});



test('Accord challenge starts through trusted combat and cannot settle an unfinished or borrowed run', () => {
  const runs = openRuns(':memory:');
  const verifyCompleted = (accountId, runId) => runId === 'clear-proof' && accountId === 'alice'
    ? { mode: 'practice', outcome: 'won', state: { talisman: 'gate' } }
    : runs.verifyCompleted(accountId, runId);
  const authority = { startMode: runs.startMode, verifyCompleted };
  const modes = openGameModes(':memory:', { runs: authority, combat: expeditionModeCombat(authority) });
  const post = (path, body, accountId = 'alice') =>
    modes.route({ method: 'POST', path: '/api/modes/trials/' + path, accountId, body });
  try {
    assert.throws(() => post('start', { trialId: 'accord-i', talisman: 'gate' }), /locked/);
    const unlocked = post('import-clear', { runId: 'clear-proof' });
    assert.deepEqual(unlocked.available.map(trial => trial.id), ['accord-i']);
    const run = post('start', { trialId: 'accord-i', talisman: 'gate' });
    assert.equal(run.challenge.trialId, 'accord-i');
    assert.equal(run.state.accordTrial.eliteVariant, 'fractured-ward');
    assert.throws(() => post('settle', { runId: run.runId }), error => error.code === 'RUN_NOT_COMPLETE');
    assert.throws(() => post('settle', { runId: run.runId }, 'bob'), /entry_missing/);
  } finally {
    modes.close();
    runs.close();
  }
});


test('Duel practice labels and executes its own bot and leaves ranked disabled', () => {
  const modes = openGameModes(':memory:', { now: () => 100 });
  const route = (path, body = {}) => modes.route({ method: 'POST', path: '/api/modes/duel/' + path, accountId: 'alice', body });
  try {
    assert.throws(() => route('ranked/join', { region: 'local' }), /ranked_unavailable/);
    const opened = route('practice');
    assert.equal(opened.practice, true);
    assert.equal(opened.players.find(player => player.bot).id, 'practice-bot');
    assert.equal(opened.players[opened.turn].id, 'alice');
    const next = route(opened.id + '/act', { nonce: opened.nonce, type: 'pass' });
    assert.ok(next.timeline.some(event => event.accountId === 'practice-bot'));
    assert.equal(next.ranked, false);
  } finally {
    modes.close();
  }
});


test('Three authenticated WebSocket players lock one private co-op choice and resolve the shared round', async () => {
  const origin = 'http://localhost:9876';
  const sessions = openGuestSessions(':memory:');
  const modes = openGameModes(':memory:', { now: () => 100 });
  const server = createGameServer({ sessions, runs: {}, modes, origin, secureCookies: false });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const clients = [];
  try {
    const players = Array.from({ length: 3 }, () => sessions.create());
    const post = (player, path) => modes.route({ method: 'POST', path: '/api/modes/' + path, accountId: player.playerId });
    const room = post(players[0], 'coop');
    for (const player of players.slice(1)) post(player, 'coop/' + room.id + '/join');
    for (const player of players) post(player, 'coop/' + room.id + '/ready');
    const peers = await Promise.all(players.map(async player => {
      const ws = new WebSocket('ws://127.0.0.1:' + server.address().port + '/api/realtime/coop/' + room.id, {
        origin, headers: { cookie: 'veilbound_guest=' + player.token },
      });
      clients.push(ws);
      const snapshot = await waitForState(ws, message => message.type === 'state');
      return { ws, state: snapshot.state };
    }));
    const locked = waitForState(peers[1].ws, message => message.type === 'state' && message.state.actors[0].locked);
    const send = (index, type) => peers[index].ws.send(JSON.stringify({ type: 'act', action: { nonce: 0, type } }));
    send(0, 'strike');
    const hidden = (await locked).state;
    assert.equal(hidden.actors[0].action, undefined);
    const resolved = waitForState(peers[0].ws, message => message.type === 'state' && message.state.round === 2);
    send(1, 'guard');
    send(2, 'strike');
    assert.deepEqual((await resolved).state.timeline[0].actions.map(action => [action.type, action.bot]),
      [['guard', false], ['strike', false], ['strike', false]]);
  } finally {
    for (const client of clients) client.terminate();
    server.closeRealtime();
    await new Promise(resolve => server.close(resolve));
    modes.close();
    sessions.close();
  }
});


test('Weekly starts an authoritative run and exposes its verified replay to the owner only', async () => {
  const origin = 'http://localhost:9876';
  const sessions = openGuestSessions(':memory:');
  const runs = openRuns(':memory:', { modeSecret: Buffer.alloc(32, 1) });
  const modes = openGameModes(':memory:', { combat: expeditionModeCombat(runs), now: () => 100, week: {
    id: 'weekly-2026', seed: 19, ruleset: 'weekly-v1', startsAt: 0, endsAt: 200, graceMs: 30,
    roster: ['rook', 'mara', 'elian'], budget: 0, rewardSlots: 1, targetRounds: 6,
  } });
  const server = createGameServer({ sessions, runs, modes, origin, secureCookies: false });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const alice = sessions.create();
    const bob = sessions.create();
    const request = (player, path, body) => fetch('http://127.0.0.1:' + server.address().port + '/api/' + path, {
      method: body ? 'POST' : 'GET',
      headers: { origin, cookie: 'veilbound_guest=' + player.token, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    const start = await request(alice, 'modes/weekly/start', { operationId: 'weekly-01' });
    assert.equal(start.status, 200);
    const { runId } = await start.json();
    const retry = await request(alice, 'modes/weekly/start', { operationId: 'weekly-01' });
    assert.equal((await retry.json()).runId, runId);
    const replay = await request(alice, 'runs/' + runId + '/replay');
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).verified, true);
    const unauthorized = await request(bob, 'runs/' + runId + '/replay');
    assert.equal(unauthorized.status, 404);
  } finally {
    server.closeRealtime();
    await new Promise(resolve => server.close(resolve));
    modes.close();
    runs.close();
    sessions.close();
  }
});


test('Mode inventory records a durable account-bound Breach reward once', () => {
  const service = openGameModes(':memory:', { now: () => 100, raid: {
    id: 'reward-raid', startsAt: 0, endsAt: 1000, graceMs: 0, hp: 200, contributionCap: 8,
    personalThreshold: 4, rewardSlots: 1, ruleset: 'v1',
  } });
  const route = (path, body, accountId = 'alice') =>
    service.route({ method: body ? 'POST' : 'GET', path: '/api/modes/' + path, accountId, body });
  try {
    const { runId } = route('raid/start', {});
    for (const [version, type] of ['wardbreak', 'mark', 'protect', 'counter', 'counter', 'burst', 'burst', 'burst'].entries()) {
      if (route('raid/' + runId + '/encounter').phase === 'active') route('raid/' + runId + '/act', { version, type });
    }
    route('raid/settle', { runId });
    route('raid/settle', { runId });
    const { rewards } = route('rewards');
    assert.equal(rewards.length, 1);
    assert.equal(rewards[0].itemId, 'breach-contributor');
    assert.equal(rewards[0].tradable, false);
    assert.equal(rewards[0].scope, 'account');
    assert.deepEqual(route('rewards', undefined, 'bob').rewards, []);
  } finally { service.close(); }
});


test('Weekly and co-op account rewards survive database reopen and retries', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'veilbound-rewards-'));
  const combat = authority();
  const config = { combat, now: () => 100, week: {
    id: 'reward-week', seed: 1, ruleset: 'v1', startsAt: 0, endsAt: 200, graceMs: 10,
    roster: ['rook', 'mara', 'elian'], budget: 0, rewardSlots: 1, targetRounds: 6,
  } };
  const file = join(directory, 'modes.sqlite');
  let service = openGameModes(file, config);
  const route = (path, body, accountId = 'alice') =>
    service.route({ method: body ? 'POST' : 'GET', path: '/api/modes/' + path, accountId, body });
  try {
    const run = route('weekly/start', {});
    combat.complete(run.runId, { objective: true, rounds: 5, faints: 0, consumables: 0 });
    route('weekly/settle', { runId: run.runId });
    const claim = route('weekly/claim', {});
    assert.equal(claim.entitlement.itemId, 'weekly-oath-cosmetic');
    for (let attempt = 0; attempt < 2; attempt++) {
      const room = route('coop', {});
      for (const player of ['bob', 'cat']) route('coop/' + room.id + '/join', {}, player);
      for (const player of ['alice', 'bob', 'cat']) route('coop/' + room.id + '/ready', {}, player);
      for (let nonce = 0; nonce < 6; nonce++) {
        for (const player of ['alice', 'bob', 'cat']) route('coop/' + room.id + '/act', { nonce, type: 'strike' }, player);
      }
      assert.equal(route('coop/' + room.id).phase, 'won');
    }
    service.close();
    service = openGameModes(file, config);
    assert.deepEqual(route('weekly/claim', {}).entitlement, claim.entitlement);
    assert.equal(route('rewards').rewards.length, 2);
    for (const player of ['bob', 'cat']) {
      const { rewards } = route('rewards', undefined, player);
      assert.equal(rewards.length, 1);
      assert.equal(rewards[0].itemId, 'breach-coop-crest');
    }
  } finally {
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

