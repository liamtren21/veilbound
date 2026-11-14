import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../../config/testnet-economy.json' with { type: 'json' };
import { simulateEconomy } from '../../scripts/simulate-economy.mjs';

test('fixture conserves Copper across reward caps, trade, craft, NPC stockout and outage', () => {
  for (const players of config.scenarioPlayers) for (const aiOutage of config.outageScenarios) {
    const report = simulateEconomy(config, { players, aiOutage });
    assert.equal(report.conservation.copperBalanced, true);
    assert.equal(report.conservation.materialsBalanced, true);
    assert.equal(report.conservation.negativeBalances, 0);
    assert.ok(BigInt(report.rewardEmittedAtomic) <= BigInt(config.campaignCapAtomic));
    for (const [mode, paid] of Object.entries(report.modeEmittedAtomic)) {
      assert.ok(BigInt(paid) <= BigInt(config.modeCapsAtomic[mode]));
    }
    assert.ok(report.players.every(player => BigInt(player.emittedAtomic) <= BigInt(config.accountCapAtomic)));
    assert.equal(report.npc.planner, aiOutage ? 'rule-based-fallback' : 'rule-based');
    assert.ok(report.crafting.crafts > 0);
    assert.equal(report.crafting.unauthorizedNftMints, 0);
    assert.equal(report.crafting.practiceExportBlocked, true);
    assert.equal(report.repeatedRewardClaimsPaid, 0);
  }
});

test('changing mode never resets a player campaign allowance', () => {
  const report = simulateEconomy({ ...config, accountCapAtomic: '100', attemptsPerPlayer: 50 }, { players: 3, aiOutage: false });
  assert.ok(report.players.every(player => BigInt(player.emittedAtomic) <= 100n));
  assert.ok(report.rewardDenied > 0);
});
