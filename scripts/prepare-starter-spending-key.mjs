import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { KeyPair } from '../server/node_modules/near-api-js/lib/index.js';

const [upgradePath, keyPath] = process.argv.slice(2);
if (!upgradePath || !keyPath) throw new Error('Usage: node scripts/prepare-starter-spending-key.mjs UPGRADE_MANIFEST NEW_PRIVATE_KEY_PATH');
const { rootAccountId, contracts, artifacts, network, feature } = JSON.parse(await readFile(upgradePath, 'utf8'));
if (network !== 'testnet' || rootAccountId !== 'vibebound.testnet' ||
    !['guest-spending', 'market-extension'].includes(feature)) {
  throw new Error('Expected the VEILBOUND Guest spending testnet upgrade');
}
let key;
try {
  key = KeyPair.fromString((await readFile(keyPath, 'utf8')).trim());
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  key = KeyPair.fromRandom('ed25519');
  await writeFile(keyPath, key.toString(), { mode: 0o600, flag: 'wx' });
}
const plan = {
  network, rootAccountId, contracts, artifacts, phase: 'onboarding', status: 'UNSIGNED',
  description: 'Authorize the new Guest onboarding key on testnet for issue_starter, link_starter and settle_starter_run only. Gas allowance is 0.1 testNEAR.',
  batches: [{ signerId: rootAccountId, receiverId: rootAccountId, actions: [{
    type: 'AddKey',
    params: { publicKey: key.getPublicKey().toString(), accessKey: { permission: {
      receiverId: contracts.core, methodNames: ['issue_starter', 'link_starter', 'settle_starter_run'],
      allowance: '100000000000000000000000',
    } } },
  }] }],
};
await writeFile(resolve(upgradePath, '..', 'testnet.onboarding.unsigned.json'), JSON.stringify(plan, null, 2), { flag: 'wx' });
