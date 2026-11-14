import { setTimeout as delay } from 'node:timers/promises';
import { createLocalNpcSigner } from '../server/src/npc/local-market-signer.mjs';
import { createCoreClient } from '../server/src/chain/core.mjs';
import { openNpcMarketWorker } from '../server/src/npc/market-worker.mjs';
import { readFile } from 'node:fs/promises';

async function main() {
  if (process.env.VEILBOUND_NPC_MARKET_ENABLED !== 'true') throw new Error('npc_market_disabled');
  const [, , configurationPath, databasePath, interval] = process.argv;
  const intervalMs = interval === undefined ? 0 : Number(interval);
  if (interval !== undefined && (!Number.isSafeInteger(intervalMs) || intervalMs < 5000 || intervalMs > 3_600_000)) {
    throw new Error('npc_market_invalid_tick_interval');
  }
  if (!configurationPath || !databasePath || databasePath === ':memory:') {
    throw new Error('usage: node scripts/tick-npc-market.mjs <configuration.json> <persistent-jobs.sqlite> [interval-ms]');
  }
  const { accountId, coreId, copperId, policy, pricing, ttlMs } = JSON.parse(await readFile(configurationPath, 'utf8'));
  const signAndSend = process.env.VEILBOUND_NPC_SIGNER_MODE === 'local'
    ? await createLocalNpcSigner({ accountId, coreId, policy })
    : remoteSigner();
  const worker = openNpcMarketWorker(databasePath, {
    enabled: true, accountId, coreId, core: createCoreClient({ coreId, copperId }), policy, pricing, ttlMs, signAndSend,
  });
  const stop = new AbortController();
  const requestStop = () => stop.abort();
  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);
  try {
    do {
      try {
        const results = await worker.tick();
        console.log(JSON.stringify(results.map(({ operationId, status, receipt, error }) => ({ operationId, status, receipt, error }))));
      } catch (error) {
        if (!intervalMs) throw error;
        logError(error);
      }
      if (!intervalMs || stop.signal.aborted || Date.now() >= policy.expiresAt) break;
      await delay(Math.min(intervalMs, policy.expiresAt - Date.now()), undefined, { signal: stop.signal })
        .catch(error => { if (error.name !== 'AbortError') throw error; });
    } while (!stop.signal.aborted);
  } finally {
    process.removeListener('SIGINT', requestStop);
    process.removeListener('SIGTERM', requestStop);
    worker.close();
  }
}

function remoteSigner() {
  const signerUrl = new URL(process.env.VEILBOUND_NPC_SIGNER_URL);
  const token = process.env.VEILBOUND_NPC_SIGNER_TOKEN;
  if (signerUrl.protocol !== 'https:' || signerUrl.username || signerUrl.password ||
      signerUrl.search || signerUrl.hash || !token) throw new Error('npc_market_signer_configuration_required');
  return async ({ accountId, operationId, transaction }) => {
      const response = await fetch(signerUrl, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ accountId, operationId, transaction }),
      });
      if (!response.ok) throw new Error('npc_market_signer_unavailable');
      const { transactionHash } = await response.json();
      if (typeof transactionHash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(transactionHash)) {
        throw new Error('npc_market_signer_invalid_result');
      }
      return { transactionHash };
  };
}
function logError(error) {
  const message = /^[a-z_:][a-z0-9_:.<> /-]{1,160}$/i.test(error.message) ? error.message : error.name;
  console.error(message);
}
main().catch(error => {
  logError(error);
  process.exitCode = 1;
});
