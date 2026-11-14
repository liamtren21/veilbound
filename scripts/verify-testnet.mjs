import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const [planPath, outputPath] = process.argv.slice(2);
if (!planPath || !outputPath) throw new Error('Usage: node scripts/verify-testnet.mjs UNSIGNED_PLAN_JSON OUTPUT_JSON');
const plan = JSON.parse(await readFile(planPath, 'utf8'));
if (plan.network !== 'testnet' || !plan.rootAccountId?.endsWith('.testnet')) throw new Error('Expected testnet deployment plan');
const rpc = 'https://test.rpc.fastnear.com';
let sequence = 0;
async function query(params) {
  const response = await fetch(rpc, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method: 'query', params: { ...params, finality: 'final' } }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error('RPC HTTP ' + response.status);
  const payload = await response.json();
  if (payload.error) throw new Error(JSON.stringify(payload.error));
  if (payload.result?.error) throw new Error(payload.result.error);
  return payload.result;
}
async function view(accountId, methodName) {
  const result = await query({ request_type: 'call_function', account_id: accountId, method_name: methodName, args_base64: 'e30=' });
  return { value: JSON.parse(Buffer.from(result.result).toString()), blockHash: result.block_hash, blockHeight: result.block_height };
}
const report = { network: 'testnet', checkedAt: new Date().toISOString(), contracts: {} };
for (const name of ['copper', 'core']) {
  const accountId = plan.contracts[name];
  if (accountId !== name + '.' + plan.rootAccountId) throw new Error('Unexpected contract account');
  const code = await query({ request_type: 'view_code', account_id: accountId });
  const hash = createHash('sha256').update(Buffer.from(code.code_base64, 'base64')).digest('hex');
  if (hash !== plan.artifacts[name].sha256) throw new Error('Deployed WASM mismatch: ' + accountId);
  report.contracts[name] = { accountId, sha256: hash, blockHash: code.block_hash, blockHeight: code.block_height };
}
report.copperMetadata = await view(plan.contracts.copper, 'ft_metadata');
report.copperSupply = await view(plan.contracts.copper, 'ft_total_supply');
report.corePaused = await view(plan.contracts.core, 'is_paused');
if (report.copperMetadata.value.decimals !== 2) throw new Error('Unexpected Copper decimals');
await writeFile(outputPath, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
