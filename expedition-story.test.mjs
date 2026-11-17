import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseEvent, enter, newRun } from './expedition-rules.mjs';
import { map, storyOpportunities } from './expedition-data.mjs';
import { dialogueContext } from './server/src/npc/context.mjs';

test('new expeditions must deliver the letter; legacy expeditions benefit by carrying it', () => {
  for (const [legacy, delivered, expected] of [[false, false, 14], [false, true, 0], [true, false, 0]]) {
    const state = newRun(71);
    if (legacy) delete state.storyVersion;
    state.node = 'house';
    assert.equal(chooseEvent(state, 'letter'), true);
    state.node = 'memorial';
    state.phase = 'event';
    if (delivered) {
      assert.equal(chooseEvent(state, 'deliver-letter'), true);
      assert.equal(chooseEvent(state, 'deliver-letter'), false);
      assert.equal(state.pack.letter, 0);
    }
    state.phase = 'map';
    state.node = 'wood-witch';
    assert.equal(enter(state, 'sanctum'), true);
    assert.equal(state.battle.defense.foe, expected);
  }
});

test('regional offers charge their specified cost and reduce opening personal Defense', () => {
  for (const [node, offer] of Object.entries(storyOpportunities)) {
    if (node === 'memorial') continue;
    const state = newRun(71);
    state.node = node;
    assert.equal(chooseEvent(state, offer.id), false);
    for (const [item, amount] of Object.entries(offer.cost)) {
      const inventory = item === 'copper' ? state : state.pack;
      inventory[item] = amount;
    }
    assert.equal(chooseEvent(state, offer.id), true);
    assert.equal(state.storyMilestones[0].boss, offer.boss);
    state.phase = 'map';
    const comparison = structuredClone(state);
    comparison.storyMilestones = [];
    assert.equal(enter(state, offer.boss, { availableNodes: [offer.boss], enemies: map[offer.boss].enemies }), true);
    assert.equal(enter(comparison, offer.boss, { availableNodes: [offer.boss], enemies: map[offer.boss].enemies }), true);
    assert.equal(state.battle.enemies[0].ward, Math.max(0, comparison.battle.enemies[0].ward - offer.reduction));
  }
});

test('NPC context contains the verified scene, local choices and eligible offer', () => {
  const state = newRun(71);
  state.node = 'memorial';
  state.pack.letter = 1;
  const context = dialogueContext({ state }, {
    'The Namekeeper': [{ node: 'memorial', choice: 'remember' }],
    'The Letter Keeper': [{ node: 'house', choice: 'letter' }],
  });
  assert.equal(context.offer.id, 'deliver-letter');
  assert.deepEqual(context.history, [{ node: 'memorial', choice: 'remember' }]);
  state.phase = 'map';
  assert.deepEqual(dialogueContext({ state }, {}), { node: null });
});
