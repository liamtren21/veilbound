import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { makeUpgradePlans, planDigest } from './lib/upgrade.mjs';

const [previousPath, outputDirectory = 'deployments', feature] = process.argv.slice(2);
if (!previousPath) throw new Error('Usage: node scripts/prepare-upgrade.mjs PREVIOUS_MANIFEST_JSON [OUTPUT_DIRECTORY]');
const previous = JSON.parse(await readFile(resolve(previousPath), 'utf8'));
if (previous.network !== 'testnet') throw new Error('Expected previous testnet manifest');
const binaries = Object.fromEntries(await Promise.all(['copper', 'core'].map(async name => [
  name, await readFile(new URL('../contracts/target/wasm32-unknown-unknown/release/veilbound_' + name + '.wasm', import.meta.url)),
])));
if (feature !== undefined && !['field-rewards', 'run-items', 'economy', 'guest-spending', 'market-extension', 'nft-run-lock'].includes(feature)) throw new Error('Unknown upgrade feature');
const plans = makeUpgradePlans({ rootAccountId: previous.rootAccountId, previousArtifacts: previous.artifacts, binaries, feature });
for (const phase of ['upgrade', 'unpause']) {
  await writeFile(resolve(outputDirectory, 'testnet.' + phase + '.unsigned.json'), JSON.stringify(plans[phase], null, 2), { flag: 'wx' });
}
console.log(JSON.stringify({ upgradeDigest: planDigest(plans.upgrade), artifacts: plans.upgrade.artifacts,
  phases: ['upgrade', 'unpause'], status: 'UNSIGNED' }, null, 2));
