import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openRuns } from '../../server/src/runs/service.mjs';
import { describe, pendingEnemyDice } from '../../expedition-rules.mjs';

test('practice run persists and retries are safe across restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'veilbound-'));
  const file = join(dir, 'runs.sqlite');
  let runs;
  try {
    runs = openRuns(file);
    const initial = runs.start('alice');
    assert.equal(initial.state.seed, undefined);
    assert.equal(runs.start('alice').runId, initial.runId);
    assert.throws(() => runs.get('bob', initial.runId), { code: 'RUN_NOT_FOUND' });
    const act = { operationId: 'op-1', expectedVersion: 0, intent: { type: 'event', choice: 'enter' } };
    const after = runs.act('alice', initial.runId, act);
    assert.equal(after.version, 1);
    assert.equal(after.state.phase, 'map');
    runs.close();
    runs = openRuns(file);
    assert.deepEqual(runs.get('alice', initial.runId), after);
    assert.deepEqual(runs.act('alice', initial.runId, act), after);
    assert.throws(() => runs.act('alice', initial.runId, { ...act, intent: { type: 'enter', node: 'road' } }), { code: 'OPERATION_CONFLICT' });
    assert.throws(() => runs.act('alice', initial.runId, { ...act, operationId: 'op-2' }), { code: 'STALE_VERSION' });
    assert.throws(() => runs.act('alice', initial.runId, { ...act, operationId: 'op-3', expectedVersion: 1, intent: { type: 'enter', node: 'invalid' } }), { code: 'INVALID_ACTION' });
    assert.deepEqual(runs.get('alice', initial.runId), after);
  } finally {
    runs?.close();
    rmSync(dir, { recursive: true });
  }
});

test('combat checks round, target, die reuse, and action payload before committing', () => {
  const runs = openRuns(':memory:');
  try {
    let snapshot = runs.start('alice', { tutorial: true });
    let sequence = 0;
    const act = intent => runs.act('alice', snapshot.runId, {
      operationId: 'combat-' + ++sequence, expectedVersion: snapshot.version, intent,
    });
    snapshot = act({ type: 'event', choice: 'enter' });
    snapshot = act({ type: 'enter', node: 'road' });
    assert.equal(snapshot.state.battle.rng, undefined);
    assert.equal(snapshot.state.economySeed, undefined);
    const valid = { type: 'use-die', dieId: 'party0', targetKey: 'e0', round: 1 };
    assert.throws(() => act({ ...valid, damage: 100000 }), { code: 'INVALID_ACTION' });
    assert.throws(() => act({ ...valid, round: 2 }), { code: 'INVALID_ACTION' });
    assert.throws(() => act({ ...valid, targetKey: 'rook' }), { code: 'INVALID_ACTION' });
    assert.throws(() => act({ type: 'end-round', round: 1 }), { code: 'INVALID_ACTION' });
    assert.deepEqual(runs.get('alice', snapshot.runId), snapshot);
    snapshot = act(valid);
    assert.equal(snapshot.state.battle.dice.find(die => die.id === 'party0').spent, true);
    assert.equal(snapshot.action.actor, 'rook');
    assert.throws(() => act(valid), { code: 'INVALID_ACTION' });
    const replay = runs.replay('alice', snapshot.runId);
    assert.equal(replay.verified, true);
    assert.equal(replay.stateHash, snapshot.stateHash);
    assert.equal(replay.events.length, 3);
    assert.equal(replay.secret, undefined);
  } finally {
    runs.close();
  }
});

test('rewarded starts fail closed without backed reward reservation', () => {
  const runs = openRuns(':memory:');
  try {
    assert.throws(() => runs.start('alice', { mode: 'expedition' }), { code: 'REWARD_RESERVATION_UNAVAILABLE' });
    assert.equal(runs.active('alice'), null);
  } finally {
    runs.close();
  }
});

test('trusted Weekly entry pins roster and seed while clients cannot create Weekly entries', () => {
  const runs = openRuns(':memory:', { modeSecret: Buffer.alloc(32, 1) });
  try {
    const spec = {
      mode: 'weekly', weeklyId: 'week-12', seed: 119, ruleset: 'v1',
      roster: ['mara', 'tess', 'rook'], budget: 0, exportLoot: false,
    };
    assert.throws(() => runs.start('alice', spec), { code: 'INVALID_MODE' });
    const alice = runs.startMode('alice', spec);
    const bob = runs.startMode('bob', { ...spec, practice: true });
    assert.deepEqual(alice.state.heroes.slice(0, 3).map(hero => hero.id), spec.roster);
    assert.equal(alice.state.benchKey, 'elian');
    assert.equal(alice.provenance, 'weekly');
    const use = (accountId, snapshot, intent) => runs.act(accountId, snapshot.runId, {
      expectedVersion: snapshot.version, operationId: 'action-' + snapshot.version, intent,
    });
    assert.throws(() => use('alice', alice, { type: 'configure', heroKey: 'rook', slot: 0, skill: 'brace' }),
      { code: 'INVALID_ACTION' });
    const enterRoad = (accountId, run) => use(accountId, use(accountId, run, { type: 'event', choice: 'enter' }),
      { type: 'enter', node: 'road' });
    assert.deepEqual(enterRoad('alice', alice).state.battle.dice, enterRoad('bob', bob).state.battle.dice);
    assert.throws(() => runs.verifyCompleted('alice', alice.runId), { code: 'RUN_NOT_COMPLETE' });
    assert.throws(() => runs.startMode('alice', { ...spec, mode: 'raid' }), { code: 'MODE_ADAPTER_UNAVAILABLE' });
  } finally {
    runs.close();
  }
});

test('defeat seals progression and a new practice run receives a fresh identity', () => {
  const runs = openRuns(':memory:', { entropy: size => Buffer.alloc(size, 2) });
  try {
    let snapshot = runs.start('alice', { tutorial: true, operationId: 'opening' });
    function act(intent) {
      snapshot = runs.act('alice', snapshot.runId, {
        expectedVersion: snapshot.version, operationId: 'step-' + snapshot.version, intent,
      });
    }
    act({ type: 'event', choice: 'enter' });
    act({ type: 'enter', node: 'road' });
    for (let index = 0; snapshot.state.phase === 'battle' && index < 250; index++) {
      const { state } = snapshot;
      const [die] = pendingEnemyDice(state);
      if (die) {
        const plan = describe(state, die.id);
        const intent = { type: 'use-die', dieId: die.id, round: state.battle.round };
        if (plan.choose) intent.targetKey = plan.targets[0].key;
        act(intent);
      } else {
        act({ type: 'end-round', round: state.battle.round });
      }
    }
    assert.equal(snapshot.lifecycle, 'LOST');
    assert.equal(snapshot.state.copper, 0);
    assert.equal(runs.verifyCompleted('alice', snapshot.runId).outcome, 'lost');
    assert.equal(snapshot.summary.faints, 3);
    assert.equal(snapshot.summary.progress.xp, 0);
    assert.equal(runs.active('alice').runId, snapshot.runId);
    assert.throws(() => act({ type: 'end-round', round: snapshot.state.battle.round }), { code: 'RUN_CLOSED' });
    assert.equal(runs.start('alice', { tutorial: true, operationId: 'opening' }).runId, snapshot.runId);
    assert.notEqual(runs.start('alice', { operationId: 'opening-2' }).runId, snapshot.runId);
  } finally {
    runs.close();
  }
});

test('trusted Trial entry applies only the canonical modifier and pins its optional support', () => {
  const runs = openRuns(':memory:');
  try {
    const spec = { mode: 'trial', trialId: 'accord-iii', talisman: 'river', exportLoot: false };
    assert.throws(() => runs.start('alice', spec), { code: 'INVALID_MODE' });
    assert.throws(() => runs.startMode('alice', spec), { code: 'INVALID_MODE_LOADOUT' });
    assert.throws(() => runs.startMode('alice', { ...spec, support: 'spiceberry' }), { code: 'INVALID_MODE_LOADOUT' });
    assert.throws(() => runs.startMode('alice', { ...spec, trialId: 'accord-i', support: 'salve' }),
      { code: 'INVALID_MODE_LOADOUT' });
    const entry = runs.startMode('alice', { ...spec, support: 'salve' });
    assert.deepEqual(entry.challenge, { trialId: 'accord-iii', talisman: 'river', support: 'salve' });
    assert.equal(entry.provenance, 'trial');
    assert.equal(entry.state.pack.salve, 1);
    assert.equal(entry.state.trial, 0);
    assert.equal(entry.state.benchKey, 'rook');
  } finally {
    runs.close();
  }
});
