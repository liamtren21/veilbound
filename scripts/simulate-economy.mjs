import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { enemyCopper } from '../expedition-data.mjs';
import { applyRunCopperCheckpoint } from '../shared/run-copper.mjs';
import { prepareCraft } from '../shared/crafting.mjs';
import { planRestock } from '../server/src/npc/policy.mjs';

const minimum = (...values) => values.reduce((lowest, value) => value < lowest ? value : lowest);
const sum = values => values.reduce((total, value) => total + value, 0n);
const atomic = value => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,38})$/.test(value)) throw new Error('invalid_fixture_amount');
  return BigInt(value);
};
const recipes = ['apothecary-ward-v1', 'relicsmith-inlay-v1', 'binder-binding-v1'];
const modes = ['expedition', 'raid', 'weekly', 'quest'];

export function simulateEconomy(config, { players, aiOutage = false }) {
  if (!Number.isSafeInteger(players) || players < 3 || players > 10000 ||
      !Number.isSafeInteger(config.attemptsPerPlayer) || config.attemptsPerPlayer < 1 || config.attemptsPerPlayer > 1000) {
    throw new Error('invalid_fixture_population');
  }
  if (!Array.isArray(config.profiles) || !config.profiles.length || config.profiles.some(profile =>
      !profile.id || !Number.isSafeInteger(profile.clearedRegions) || profile.clearedRegions < 0 || profile.clearedRegions > 5 ||
      !Number.isSafeInteger(profile.clearEvery) || profile.clearEvery < 1 ||
      !Number.isFinite(profile.durationMinutes) || profile.durationMinutes <= 0) ||
      !Number.isSafeInteger(config.npcTargetStock) || config.npcTargetStock < 1 ||
      Object.entries(config.materialCaps).some(([item, cap]) => !Number.isSafeInteger(cap) || cap < 0 ||
        !Number.isSafeInteger(config.materialGrant[item]) || config.materialGrant[item] < 0)) {
    throw new Error('invalid_fixture_assumption');
  }
  const globalCap = atomic(config.campaignCapAtomic);
  const modeCaps = Object.fromEntries(modes.map(mode => [mode, atomic(config.modeCapsAtomic[mode])]));
  if (sum(Object.values(modeCaps)) > globalCap) throw new Error('fixture_mode_cap_exceeds_campaign');
  const accountCap = atomic(config.accountCapAtomic);
  const modeEmitted = Object.fromEntries(modes.map(mode => [mode, 0n]));
  let emitted = 0n;
  let rewardDenied = 0;
  let repeatedRewardClaimsPaid = 0;
  const claims = new Set();
  const stock = () => ({});
  const accounts = Array.from({ length: players }, (_, index) => ({
    id: 'player-' + index, profile: config.profiles[index % config.profiles.length],
    copper: 0n, emitted: 0n, inventory: stock(), gross: 0n, spending: 0n, attempted: 0,
  }));
  const trader = { id: 'trader', copper: atomic(config.bootstrapAtomic), inventory: stock() };
  const npc = { id: 'npc', copper: atomic(config.npcCapitalAtomic), inventory: stock() };
  const treasury = { id: 'treasury', copper: 0n, inventory: stock() };
  const materialEmitted = Object.fromEntries(Object.keys(config.materialCaps).map(item => [item, 0]));
  const consumed = {};
  const crafted = {};
  let materialStockouts = 0;
  let npcStockouts = 0;
  let trades = 0;
  let craftCount = 0;
  const initialSupply = trader.copper + npc.copper;
  const transfer = (from, to, amount) => {
    if (amount < 0n || from.copper < amount) throw new Error('fixture_insufficient_balance');
    from.copper -= amount;
    to.copper += amount;
  };
  const moveItem = (from, to, itemId, quantity) => {
    if (!Number.isSafeInteger(quantity) || quantity < 1 || (from.inventory[itemId] ?? 0) < quantity) throw new Error('fixture_insufficient_material');
    from.inventory[itemId] -= quantity;
    to.inventory[itemId] = (to.inventory[itemId] ?? 0) + quantity;
  };
  const reward = (player, mode, claimId, requested) => {
    if (claims.has(claimId)) return 0n;
    claims.add(claimId);
    const amount = minimum(requested, globalCap - emitted, modeCaps[mode] - modeEmitted[mode], accountCap - player.emitted);
    if (amount < requested) rewardDenied++;
    player.copper += amount;
    player.emitted += amount;
    emitted += amount;
    modeEmitted[mode] += amount;
    return amount;
  };
  const coinPerRegion = Object.values(enemyCopper).reduce((total, value) => total + value, 0);
  for (let attempt = 0; attempt < config.attemptsPerPlayer; attempt++) for (const player of accounts) {
    const { profile } = player;
    const won = attempt % profile.clearEvery === 0;
    const regions = won ? profile.clearedRegions : Math.max(0, profile.clearedRegions - 1);
    let purse = 0;
    let banked = 0n;
    for (let region = 1; region <= regions; region++) {
      purse += coinPerRegion;
      const result = applyRunCopperCheckpoint({ copper: purse, phase: won && region === 5 ? 'complete' : 'event' }, { region, node: 'fixture-region-' + region });
      purse = result.remaining;
      banked += BigInt(result.checkpoint.copperAtomic);
    }
    if (!won) applyRunCopperCheckpoint({ copper: purse, phase: 'defeat' });
    const mode = modes[attempt % modes.length];
    const claimId = player.id + '-' + attempt;
    const paid = reward(player, mode, claimId, banked);
    repeatedRewardClaimsPaid += Number(reward(player, mode, claimId, banked) !== 0n);
    player.gross += paid;
    player.attempted++;
    if (won) for (const [itemId, quantity] of Object.entries(config.materialGrant)) {
      const available = config.materialCaps[itemId] - materialEmitted[itemId];
      const granted = Math.min(quantity, available);
      if (granted < quantity) materialStockouts++;
      materialEmitted[itemId] += granted;
      player.inventory[itemId] = (player.inventory[itemId] ?? 0) + granted;
    }
    for (const recipeId of recipes) {
      const lots = Object.entries(player.inventory).filter(([, quantity]) => quantity > 0)
        .map(([itemId, quantity]) => ({ id: itemId, itemId, quantity, provenance: 'settled' }));
      let prepared;
      try { prepared = prepareCraft({ recipeId, version: 1, lots, workshop: 'public' }); }
      catch (error) {
        if (error.message === 'missing_materials') continue;
        throw error;
      }
      const cost = BigInt(prepared.copperAtomic);
      if (player.copper < cost) continue;
      for (const [itemId, quantity] of Object.entries(prepared.inputs)) {
        player.inventory[itemId] -= quantity;
        consumed[itemId] = (consumed[itemId] ?? 0) + quantity;
      }
      transfer(player, treasury, cost);
      player.spending += cost;
      const output = prepared.output;
      player.inventory[output.itemId] = (player.inventory[output.itemId] ?? 0) + output.quantity;
      crafted[output.itemId] = (crafted[output.itemId] ?? 0) + output.quantity;
      craftCount++;
    }
    const price = atomic(config.tradeUnitPriceAtomic);
    if ((player.inventory.ward ?? 0) > 0 && trader.copper >= price) {
      transfer(trader, player, price);
      moveItem(player, trader, 'ward', 1);
      trades++;
    }
    // A completed ward is consumed by the next buyer's run. Sale volume alone earns no reward.
    const buyer = accounts[(accounts.indexOf(player) + 1) % accounts.length];
    if ((trader.inventory.ward ?? 0) > 0 && buyer.copper >= price) {
      transfer(buyer, trader, price);
      trader.inventory.ward--;
      consumed.ward = (consumed.ward ?? 0) + 1;
      buyer.spending += price;
      trades++;
    }
  }
  // Finite NPC demand is based on stock, with a shared budget across all items.
  for (const seller of accounts) {
    const policy = {
      epoch: 1, expiresAt: 2000, methods: ['buy'], itemIds: Object.keys(config.materialCaps),
      maxQuantity: config.npcTargetStock, maxUnitPriceAtomic: config.npcMaxUnitPriceAtomic,
      budgetRemainingAtomic: npc.copper.toString(),
      targetStock: Object.fromEntries(Object.keys(config.materialCaps).map(item => [item, config.npcTargetStock])),
    };
    const quotes = Object.fromEntries(Object.keys(config.materialCaps).filter(item => seller.inventory[item] > 0)
      .map(item => [item, { askAtomic: config.tradeUnitPriceAtomic, expiresAt: 1500 }]));
    const planned = planRestock({ policy, snapshot: { epoch: 1, availableAtomic: npc.copper.toString(), stock: npc.inventory }, quotes, now: 1000 });
    for (const action of planned.actions) {
      const quantity = Math.min(action.quantity, seller.inventory[action.itemId] ?? 0);
      if (!quantity) continue;
      transfer(npc, seller, BigInt(action.unitPriceAtomic) * BigInt(quantity));
      moveItem(seller, npc, action.itemId, quantity);
      trades++;
    }
    if (!planned.actions.length) npcStockouts++;
  }
  let practiceExportBlocked = false;
  try {
    prepareCraft({ recipeId: recipes[0], version: 1, workshop: 'public', lots: [
      { id: 'practice-salt', itemId: 'salt', quantity: 2, provenance: 'practice' },
      { id: 'resin', itemId: 'resin', quantity: 1, provenance: 'settled' },
    ] });
  } catch (error) { practiceExportBlocked = error.message === 'unsettled_material'; }
  const all = [...accounts, trader, npc, treasury];
  const materialIds = new Set([...Object.keys(materialEmitted), ...Object.keys(crafted)]);
  const materialsBalanced = [...materialIds].every(item => {
    const held = all.reduce((total, owner) => total + (owner.inventory[item] ?? 0), 0);
    return held + (consumed[item] ?? 0) === (materialEmitted[item] ?? 0) + (crafted[item] ?? 0);
  });
  const supply = sum(all.map(owner => owner.copper));
  const sorted = accounts.map(owner => owner.copper).sort((a, b) => a > b ? -1 : a < b ? 1 : 0);
  const playerSupply = sum(sorted);
  const reportPlayers = accounts.map(player => ({
    id: player.id, profile: player.profile.id, emittedAtomic: player.emitted.toString(),
    copperAtomic: player.copper.toString(), grossPerRunAtomic: (player.gross / BigInt(player.attempted)).toString(),
    netPerRunAtomic: ((player.gross - player.spending) / BigInt(player.attempted)).toString(),
    assumedDurationMinutes: player.profile.durationMinutes,
  }));
  return {
    version: config.version, proofLevel: config.proofLevel, players: reportPlayers, aiOutage,
    rewardEmittedAtomic: emitted.toString(), rewardDenied, repeatedRewardClaimsPaid,
    modeEmittedAtomic: Object.fromEntries(Object.entries(modeEmitted).map(([mode, paid]) => [mode, paid.toString()])),
    materialEmitted, materialStockouts, trades,
    trader: { copperAtomic: trader.copper.toString(), inventory: trader.inventory },
    treasury: { copperAtomic: treasury.copper.toString() },
    artifactFactory: {
      authority: 'owner-only', materialConsumption: 'undefined-in-current-factory',
      modeledMints: 0, vaultStorageCost: 'requires-WASM-size-and-chain-storage-byte-cost',
    },
    npc: { planner: aiOutage ? 'rule-based-fallback' : 'rule-based', availableAtomic: npc.copper.toString(), inventory: npc.inventory, noPurchases: npcStockouts },
    crafting: { crafts: craftCount, outputs: crafted, consumed, feesAtomic: treasury.copper.toString(),
      practiceExportBlocked, unauthorizedNftMints: 0, artifactMaterialOutputs: ['relic-inlay', 'binding'] },
    concentration: { topTenPercentShareBps: playerSupply ? Number(sum(sorted.slice(0, Math.max(1, Math.ceil(players / 10)))) * 10000n / playerSupply) : 0 },
    conservation: {
      initialFixtureCopperAtomic: initialSupply.toString(), finalCopperAtomic: supply.toString(),
      copperBalanced: supply === initialSupply + emitted, materialsBalanced,
      negativeBalances: all.filter(owner => owner.copper < 0n || Object.values(owner.inventory).some(quantity => quantity < 0)).length,
    },
  };
}

async function main() {
  const config = JSON.parse(await readFile(new URL('../config/testnet-economy.json', import.meta.url), 'utf8'));
  const scenarios = config.scenarioPlayers.flatMap(players => config.outageScenarios.map(aiOutage =>
    simulateEconomy(config, { players, aiOutage })));
  if (scenarios.some(report => !report.conservation.copperBalanced || !report.conservation.materialsBalanced || report.conservation.negativeBalances)) {
    throw new Error('Economy conservation failed');
  }
  const output = resolve(process.argv[2] ?? 'evidence/economy-balance.json');
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, JSON.stringify({ generatedAt: new Date().toISOString(), assumptions: config.notes, scenarios }, null, 2));
  const rows = scenarios.map(report => '| ' + report.players.length + ' | ' + report.npc.planner + ' | ' +
    report.rewardEmittedAtomic + ' | ' + report.rewardDenied + ' | ' + report.crafting.crafts + ' | ' +
    report.materialStockouts + ' | ' + report.concentration.topTenPercentShareBps + ' |');
  const markdown = [
    '# Economy fixture conservation', '',
    ...config.notes.map(note => '- ' + note), '',
    '| Players | NPC planner | Reward atomic | Capped claims | Crafts | Material stockouts | Top 10% share bps |',
    '| ---: | --- | ---: | ---: | ---: | ---: | ---: |', ...rows, '',
    'Budget allocation follows a deterministic attempt order. The concentration metric therefore includes ordering effects from the fixture.',
    'All scenarios conserve Copper and item quantities and enforce campaign, account and mode caps. Bootstrap and NPC capital are recorded separately from rewards.',
    'Artifact materials reach validated recipe outputs. Full NFT mint economics remain dependent on owner authorization, vault NEAR storage and a defined material-to-artifact recipe. Current contracts do not consume inlay or binding during factory creation.',
    'AI outage selects the existing rule planner. No model output, real user performance, market demand, or finalized chain emission is measured by this fixture.', '',
  ].join('\n');
  await writeFile(resolve(output, '..', 'economy-balance.md'), markdown);
  console.log(JSON.stringify({ output, scenarios: scenarios.length, conserved: true }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();

