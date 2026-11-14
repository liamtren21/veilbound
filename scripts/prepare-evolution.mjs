import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { createCoreClient } from '../server/src/chain/core.mjs';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error('Usage: node scripts/prepare-evolution.mjs <approved-recipes.json> <unsigned-manifest.json>');
}
const inputs = JSON.parse(await readFile(inputPath, 'utf8'));
if (!Array.isArray(inputs) || inputs.length !== 2 || inputs.some((input, i) => input.stage !== i + 1)) {
  throw new Error('Provide approved recipes in order for stages 1 and 2');
}
const rootAccountId = 'vibebound.testnet';
const coreId = 'core.' + rootAccountId;
const copperId = 'copper.' + rootAccountId;
const core = createCoreClient({ coreId, copperId });
const rpc = await fetch('https://test.rpc.fastnear.com', {
  method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
  body: JSON.stringify({ jsonrpc: '2.0', id: 'evolution', method: 'query',
    params: { request_type: 'view_code', finality: 'final', account_id: coreId } }),
});
const { result } = await rpc.json();
if (!rpc.ok || !result?.code_base64 || !result.block_hash) throw new Error('Cannot read finalized Core WASM');
const items = JSON.parse(await readFile(new URL('../config/material-rewards.testnet.json', import.meta.url), 'utf8'));
const recipes = {};
const actions = [];
const positive = value => typeof value === 'string' && /^[1-9][0-9]{0,38}$/.test(value) && BigInt(value) < 1n << 128n;
for (const { stage, media, imagePath, materials, copperAtomic } of inputs) {
  if (typeof imagePath !== 'string' || typeof media !== 'string' || media.length > 512 ||
      !/^(https|ipfs):\/\/[^\s]+$/.test(media) || !positive(copperAtomic) ||
      !materials || typeof materials !== 'object' || Array.isArray(materials)) throw new Error('Invalid recipe for stage ' + stage);
  const ids = Object.keys(materials);
  if (!ids.length || ids.length > 16 || ids.some(id => !Object.hasOwn(items, id) || !positive(materials[id]))) {
    throw new Error('Invalid materials for stage ' + stage);
  }
  const bytes = await readFile(imagePath);
  if (!bytes.length) throw new Error('Empty media file for stage ' + stage);
  const mediaUrl = media.startsWith('ipfs://')
    ? 'https://ipfs.io/ipfs/' + media.slice('ipfs://'.length)
    : media;
  const response = await fetch(mediaUrl, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) {
    throw new Error('Published media is not a reachable image for stage ' + stage);
  }
  const digest = createHash('sha256');
  let length = 0;
  for await (const part of response.body) {
    length += part.byteLength;
    if (length > bytes.length) throw new Error('Published media differs for stage ' + stage);
    digest.update(part);
  }
  if (length !== bytes.length || digest.digest('base64') !== createHash('sha256').update(bytes).digest('base64')) {
    throw new Error('Published media differs for stage ' + stage);
  }
  const recipe = recipes[stage] = { item_ids: ids, amounts: ids.map(id => materials[id]), copper_cost: copperAtomic,
    media, media_hash: createHash('sha256').update(bytes).digest('base64') };
  const { value } = await core.evolutionRecipe(stage, result.block_hash);
  if (value && !isDeepStrictEqual(value, recipe)) throw new Error('Stage ' + stage + ' already has a different immutable recipe');
  if (!value) actions.push({ type: 'FunctionCall', params: { methodName: 'register_evolution_recipe',
    args: { stage, recipe }, gas: '30000000000000', deposit: '0' } });
}
const plan = { phase: 'evolution', status: 'UNSIGNED', network: 'testnet', rootAccountId,
  description: 'Register approved Relic evolution media, material costs and Copper costs on NEAR testnet.',
  contracts: { core: coreId }, artifacts: { core: { sha256: createHash('sha256').update(
    Buffer.from(result.code_base64, 'base64')).digest('hex') } }, recipes,
  batches: actions.length ? [{ signerId: rootAccountId, receiverId: coreId, actions }] : [] };
await writeFile(outputPath, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
console.log('Prepared ' + actions.length + ' unsigned evolution registrations');
