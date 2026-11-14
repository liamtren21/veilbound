import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const config = JSON.parse(await readFile(new URL('deployments/testnet.config.json', root)));
const copper = 'copper.' + config.rootAccountId;
const core = 'core.' + config.rootAccountId;
async function query(params) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch('https://test.rpc.fastnear.com', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'verify-setup', method: 'query', params: { ...params, finality: 'final' } }),
      signal: AbortSignal.timeout(25000) });
    const data = await response.json();
    if (response.ok && !data.error && !data.result?.error) return data.result;
    if (attempt === 2) throw new Error(JSON.stringify(data.error ?? data));
  }
}
async function view(account, method, args = {}) {
  const data = await query({ request_type: 'call_function', account_id: account, method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  return { value: JSON.parse(Buffer.from(data.result).toString()), blockHash: data.block_hash, blockHeight: data.block_height };
}
const report = { checkedAt: new Date().toISOString(), network: 'testnet', root: config.rootAccountId, checks: {} };
const checks = [
  ['supply', copper, 'ft_total_supply', {}],
  ['custody', copper, 'ft_balance_of', { account_id: core }],
  ['allocated', core, 'get_total_allocated', {}],
  ['operatorBalance', core, 'get_balance', { account_id: config.rootAccountId }],
  ['paused', core, 'is_paused', {}],
  ['starterConfiguration', core, 'get_starter_configuration', {}],
];
for (const [name, account, method, args] of checks) report.checks[name] = await view(account, method, args);
if (report.checks.paused.value !== false) throw new Error('Core is still paused');
if (report.checks.custody.value !== report.checks.allocated.value) throw new Error('Custody mismatch');
if (report.checks.supply.value !== '100000') throw new Error('Unexpected bootstrap supply');
for (const id of ['starter-001', 'shop-001']) {
  const artifact = await view(core, 'get_artifact', { token_id: id });
  const token = await view(core, 'nft_token', { token_id: id });
  if (artifact.value.status !== 'ready') throw new Error('Artifact not ready: ' + id);
  const keys = await query({ request_type: 'view_access_key_list', account_id: artifact.value.vault_id });
  if (keys.keys.length) throw new Error('Vault has access keys');
  report.checks[id] = { artifact, token, vaultKeyCount: keys.keys.length };
}
for (const id of ['apothecary-ward-v1', 'relicsmith-inlay-v1', 'binder-binding-v1']) {
  report.checks[id] = await view(core, 'get_recipe', { recipe_id: id });
  if (!report.checks[id].value) throw new Error('Recipe missing');
}
await writeFile(new URL('deployments/testnet.setup.verified.json', root), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
