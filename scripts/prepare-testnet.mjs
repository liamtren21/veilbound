import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDeploymentPlan } from './lib/deployment.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [configPath, outputPath] = process.argv.slice(2);
if (!configPath || !outputPath) throw new Error('Usage: node scripts/prepare-testnet.mjs CONFIG_JSON OUTPUT_JSON');
const config = JSON.parse(await readFile(resolve(configPath), 'utf8'));
const binaries = {};
for (const name of ['copper', 'core', 'vault']) {
  binaries[name] = await readFile(resolve(root, 'contracts/target/wasm32-unknown-unknown/release/veilbound_' + name + '.wasm'));
}
const plan = makeDeploymentPlan(config, binaries);
await mkdir(resolve(outputPath, '..'), { recursive: true });
await writeFile(resolve(outputPath), JSON.stringify(plan, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ output: resolve(outputPath), contracts: plan.contracts, artifacts: plan.artifacts, status: plan.status }, null, 2));
