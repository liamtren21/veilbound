import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createCoreClient } from '../server/src/chain/core.mjs';
import { createShopSnapshotReader } from '../server/src/chain/shop-snapshot.mjs';
import { createLocalNpcSigner } from '../server/src/npc/local-market-signer.mjs';
import { openNpcMarketWorker } from '../server/src/npc/market-worker.mjs';
import { planRestock } from '../server/src/npc/policy.mjs';
import { stockPrices } from '../server/src/npc/shop-operator.mjs';
import { openMarketIndex } from '../server/src/orders/market-index.mjs';

const { coreId, copperId, budgetAtomicPerNpc, ttlMs, npcs } = JSON.parse(await readFile(
  new URL('../config/npc-market-pilot.testnet.json', import.meta.url), 'utf8'));
const [expiry, ...flags] = process.argv.slice(2);
const expiresAt = Date.parse(expiry);
const execute = flags[0] === '--execute-testnet';
if (!expiry || !Number.isSafeInteger(expiresAt) || flags.length > (execute ? 1 : 0) ||
    (execute && !process.env.VEILBOUND_NPC_DATA_DIR)) {
  throw new Error('Usage: node scripts/npc-market-pilot.mjs <expiry-UTC> [--execute-testnet with VEILBOUND_NPC_DATA_DIR]');
}
const core = createCoreClient({ coreId, copperId });
const stop = new AbortController();
const requestStop = () => stop.abort();
process.once('SIGINT', requestStop);
process.once('SIGTERM', requestStop);
const workers = [];
const marketPath = process.env.VEILBOUND_NPC_MARKET_INDEX;
const market = execute && marketPath ? openMarketIndex(marketPath, { coreId, economy: core }) : null;
try {
  for (const [accountId, anchors] of Object.entries(npcs)) {
    const itemIds = Object.keys(anchors);
    const policy = { epoch: 1, expiresAt, methods: ['buy'], itemIds, maxQuantity: 1,
      maxUnitPriceAtomic: '125', budgetRemainingAtomic: budgetAtomicPerNpc,
      targetStock: Object.fromEntries(itemIds.map(id => [id, 1])) };
    const pricing = Object.fromEntries(itemIds.map(id => [id, {
      anchorAtomic: anchors[id], spreadBps: 1000, stockImpactBps: 0,
    }]));
    const signAndSend = await createLocalNpcSigner({ accountId, coreId, policy });
    const readSnapshot = createShopSnapshotReader({ coreId, epoch: policy.epoch });
    if (execute) {
      const directory = process.env.VEILBOUND_NPC_DATA_DIR;
      await mkdir(directory, { recursive: true });
      const legacyDatabase = join(process.env.VEILBOUND_SECRETS_DIR ?? join(homedir(), '.veilbound-secrets'), 'provisioner-market.sqlite');
      const usingLegacy = accountId === 'provisioner.vibebound.testnet' && await stat(legacyDatabase)
        .then(info => info.isFile(), error => { if (error.code === 'ENOENT') return false; throw error; });
      const database = usingLegacy ? legacyDatabase : join(directory, accountId + '.sqlite');
      workers.push({ accountId, worker: openNpcMarketWorker(database,
        { enabled: true, accountId, coreId, core, policy, pricing, ttlMs, readSnapshot, signAndSend,
          publishOrder: market && ((owner, hash) => market.publish(owner, hash)) }) });
      continue;
    }
    const snapshot = await readSnapshot(accountId, itemIds);
    const now = Date.now();
    const quotes = Object.fromEntries(itemIds.map(id => [id, { askAtomic: stockPrices({
      stock: snapshot.stock[id], target: policy.targetStock[id], ...pricing[id],
    }).bidAtomic, expiresAt: Math.min(now + ttlMs, expiresAt) }]));
    console.log(JSON.stringify({ accountId, blockHeight: snapshot.blockHeight, availableAtomic: snapshot.availableAtomic,
      reservedAtomic: snapshot.reservedAtomic, ...planRestock({ policy, snapshot, quotes, now }) }));
  }
  while (execute && !stop.signal.aborted) {
    for (const { accountId, worker } of workers) {
      try {
        const results = await worker.tick();
        await worker.publishOrders();
        console.log(JSON.stringify({ accountId, results: results.map(({ operationId, status, receipt, error }) => (
          { operationId, status, receipt, error }
        )) }));
      } catch {
        console.error('NPC tick failed for ' + accountId + '. The next tick will reconcile final state.');
      }
    }
    if (Date.now() > expiresAt + ttlMs) break;
    await delay(30_000, undefined, { signal: stop.signal }).catch(error => {
      if (error.name !== 'AbortError') throw error;
    });
  }
} finally {
  for (const { worker } of workers) worker.close();
  market?.close();
  process.off('SIGINT', requestStop);
  process.off('SIGTERM', requestStop);
}
