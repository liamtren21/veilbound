import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifyUpgrade } from './lib/upgrade-verification.mjs';

const [planPath = 'deployments/testnet.upgrade.unsigned.json', outputPath = 'deployments/testnet.upgrade.verified.json'] = process.argv.slice(2);
const plan = JSON.parse(await readFile(resolve(planPath), 'utf8'));
const rpc = async (method, params) => {
  const response = await fetch('https://test.rpc.fastnear.com', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'upgrade-verification', method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error('Upgrade RPC unavailable');
  return response.json();
};
const report = await verifyUpgrade(plan, rpc);
await writeFile(resolve(outputPath), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
