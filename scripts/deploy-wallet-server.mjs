import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { planDigest, receiptMatchesBatch } from './lib/upgrade.mjs';
import { preflightUpgrade, verifyUpgrade } from './lib/upgrade-verification.mjs';
const root = new URL('../', import.meta.url);
const phase = process.env.VEILBOUND_DEPLOY_PHASE ?? 'deploy';
if (!['deploy', 'setup', 'onboarding', 'upgrade', 'unpause', 'field-operator', 'material-budgets', 'material-catalog', 'npc-accounts', 'npc-capital', 'fastauth-relay', 'evolution'].includes(phase)) throw new Error('Unknown deploy phase');
const setup = phase === 'setup';
const upgradePhase = phase === 'upgrade' || phase === 'unpause';
const planFile = phase === 'deploy' ? 'testnet.unsigned.json' : 'testnet.' + phase + '.unsigned.json';
const deploymentDirectory = process.env.VEILBOUND_DEPLOY_DIRECTORY ?? fileURLToPath(new URL('deployments/', root));
const verifiedFile = resolve(deploymentDirectory, 'testnet.upgrade.verified.json');
const plan = JSON.parse(await readFile(resolve(deploymentDirectory, planFile), 'utf8'));
if (plan.network !== 'testnet' || plan.rootAccountId !== 'vibebound.testnet') throw new Error('Unexpected deployment plan');
const digest = planDigest(plan);
const bundle = await build({ entryPoints: [fileURLToPath(new URL('scripts/deploy-wallet.mjs', root))], bundle: true, write: false, format: 'esm', platform: 'browser' });
const port = Number(process.env.VEILBOUND_DEPLOY_PORT ?? 8790);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid deployment port');
const origin = `http://127.0.0.1:${port}`;
const page = `<!doctype html><meta charset="utf-8"><title>VEILBOUND testnet deploy</title>
<style>body{font:18px system-ui;max-width:760px;margin:60px auto;background:#182226;color:#eee}button{padding:12px;margin:10px}pre{white-space:pre-wrap}</style>
<h1>VEILBOUND testnet deployment</h1><p>Signer vibebound.testnet</p>
<p>${upgradePhase || ['field-operator', 'material-budgets', 'material-catalog', 'npc-accounts', 'npc-capital', 'fastauth-relay', 'evolution'].includes(phase) ? plan.description : phase === 'onboarding' ? plan.description : setup ? plan.description + ' Attached deposits total 2.47642 testNEAR plus fees. Economic operations will be enabled on testnet.' :
  'Create Copper and Core, initialize contracts, then pin the Vault template. Funding is 3 testNEAR for Copper and 9 testNEAR for Core, plus fees. Core stays paused.'}</p>
<button id="connect">Connect wallet</button><button id="deploy" disabled>${phase === 'evolution' ? 'Register evolution recipes' : phase === 'fastauth-relay' ? 'Create FastAuth relayer' : phase === 'npc-capital' ? 'Fund and authorize NPCs' : phase === 'npc-accounts' ? 'Create four NPC accounts' : phase === 'material-catalog' ? 'Register reward materials' : phase === 'material-budgets' ? 'Configure material rewards' : phase === 'field-operator' ? 'Configure Field operator' : phase === 'upgrade' ? 'Pause and upgrade contracts' : phase === 'unpause' ? 'Unpause verified contracts' : phase === 'onboarding' ? 'Authorize onboarding key' : setup ? 'Configure testnet' : 'Deploy'} — approve in wallet</button><pre id="status">Connect your testnet wallet.</pre>
<script type="module" src="/wallet.js"></script>`;
async function rpc(method, params) {
  const response = await fetch('https://test.rpc.fastnear.com', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'deploy', method, params }), signal: AbortSignal.timeout(30000) });
  return response.json();
}
createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403).end(); return; }
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET' && req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(page); return; }
    if (req.method === 'GET' && req.url === '/wallet.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].contents); return; }
    if (req.method === 'GET' && req.url === '/plan') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(plan)); return; }
    if (req.method === 'GET' && req.url === '/progress') {
      const directory = new URL('evidence/testnet/', root);
      const prefix = phase + '-';
      const completed = [];
      for (const name of await readdir(directory).catch(() => [])) {
        if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
        const receipt = JSON.parse(await readFile(new URL(name, directory), 'utf8'));
        const index = Number(name.slice(prefix.length).split('-')[0]);
        if (Number.isInteger(index) && (!upgradePhase || receipt.manifestDigest === digest && receipt.phase === phase) &&
          receiptMatchesBatch(plan, index, receipt)) completed.push(index);
      }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ completed })); return;
    }
    if (req.method !== 'POST' || req.headers.origin !== origin) { res.writeHead(403).end(); return; }
    let text = '';
    for await (const chunk of req) { text += chunk; if (text.length > 16384) throw new Error('Request too large'); }
    const input = JSON.parse(text);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/preflight') {
      if (!Number.isInteger(input.index) || !plan.batches[input.index]) throw new Error('Invalid phase batch');
      if (phase === 'field-operator' && input.index === 2) {
        const proof = await rpc('query', { request_type: 'call_function', account_id: plan.contracts.core,
          method_name: 'get_operation', finality: 'final', args_base64: Buffer.from(JSON.stringify({
            operation_id: 'field-capital-v1', account_id: plan.rootAccountId, kind: 'withdraw',
          })).toString('base64') });
        const value = proof.result?.result && JSON.parse(Buffer.from(proof.result.result).toString());
        if (value?.status !== 'settled' || value.amount !== plan.copperAtomic) throw new Error('Wait for the Field capital withdrawal to settle');
      }
      if (phase === 'npc-capital') {
        if (input.index > 0) {
          const args = Buffer.from(JSON.stringify({operation_id:'npc-capital-v1', account_id:plan.rootAccountId, kind:'withdraw'})).toString('base64');
          const proof = await rpc('query', {request_type:'call_function', account_id:plan.contracts.core,
            method_name:'get_operation', finality:'final', args_base64:args});
          const value = proof.result?.result && JSON.parse(Buffer.from(proof.result.result).toString());
          if (value?.status !== 'settled' || value.amount !== '4000') throw new Error('Wait for the Copper withdrawal to settle');
        }
        res.end(JSON.stringify({ready:true}));
        return;
      }
      if (['npc-accounts', 'fastauth-relay'].includes(phase)) {
        const account = await rpc('query', { request_type: 'view_account',
          account_id: plan.batches[input.index].receiverId, finality: 'final' });
        if (account.error?.cause?.name !== 'UNKNOWN_ACCOUNT') throw new Error('Target account already exists or RPC is unavailable');
        res.end(JSON.stringify({ ready: true }));
        return;
      }
      const verified = phase === 'unpause' ? JSON.parse(await readFile(verifiedFile, 'utf8')) : undefined;
      res.end(JSON.stringify(await preflightUpgrade(plan, input.index, rpc, verified)));
      return;
    }
    if (req.url === '/verify' && upgradePhase) {
      const report = await verifyUpgrade(plan, rpc);
      await writeFile(verifiedFile, JSON.stringify(report, null, 2));
      res.end(JSON.stringify(report));
      return;
    }
    if (req.url === '/rpc') {
      if (!['view_account', 'view_code', 'call_function'].includes(input.request_type) ||
          ![plan.rootAccountId, ...Object.values(plan.contracts)].includes(input.account_id)) throw new Error('Invalid RPC');
      res.end(JSON.stringify(await rpc('query', { ...input, finality: 'final' }))); return;
    }
    if (req.url === '/record') {
      if (!Number.isInteger(input.index) || !plan.batches[input.index] || !/^[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(input.hash)) throw new Error('Invalid receipt');
      const receipt = await rpc('tx', { tx_hash: input.hash, sender_account_id: plan.batches[input.index].signerId ?? plan.rootAccountId, wait_until: 'FINAL' });
      const result = receipt.result;
      if (receipt.error || !receiptMatchesBatch(plan, input.index, receipt)) throw new Error('Final transaction does not match this phase and batch');
      receipt.phase = phase;
      receipt.manifestDigest = digest;
      const directory = new URL('evidence/testnet/', root);
      await mkdir(directory, { recursive: true });
      await writeFile(new URL(phase + '-' + input.index + '-' + input.hash + '.json', directory), JSON.stringify(receipt, null, 2));
      res.end(JSON.stringify({ confirmed: true })); return;
    }
    res.writeHead(404).end('{}');
  } catch (error) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
}).listen(port, '127.0.0.1', () => console.log('Wallet signing page ' + origin));

