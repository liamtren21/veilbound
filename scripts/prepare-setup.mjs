import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../', import.meta.url);
const deployed = JSON.parse(await readFile(new URL('deployments/testnet.unsigned.json', root), 'utf8'));
const verified = JSON.parse(await readFile(new URL('deployments/testnet.verified.json', root), 'utf8'));
for (const name of ['copper', 'core']) {
  if (verified.contracts[name].sha256 !== deployed.artifacts[name].sha256) throw new Error('Verified build mismatch');
}
const owner = deployed.rootAccountId;
const { copper, core } = deployed.contracts;
const vault = await readFile(new URL('contracts/target/wasm32-unknown-unknown/release/veilbound_vault.wasm', root));
if (createHash('sha256').update(vault).digest('hex') !== deployed.artifacts.vault.sha256) throw new Error('Vault changed');
const batches = [];
const action = (methodName, args, deposit = '0', gas = '50000000000000') =>
  ({ type: 'FunctionCall', params: { methodName, args, deposit, gas } });
const batch = (receiverId, actions) => batches.push({ signerId: owner, receiverId, actions });
batch(copper, [
  action('storage_deposit', { account_id: owner, registration_only: true }, '10000000000000000000000'),
  action('bootstrap', { claim_id: 'setup-bootstrap-v1', receiver_id: owner, amount: '100000' }),
]);
batch(core, [action('fund_storage', {}, '100000000000000000000000')]);
batch(copper, [action('ft_transfer_call', { receiver_id: core, amount: '100000',
  msg: JSON.stringify({ operation_id: 'setup-deposit-v1' }) }, '1', '150000000000000')]);
batch(core, [
  action('set_paused', { paused: false }),
  ...['salt', 'resin', 'salve', 'ward', 'iron', 'relic-inlay', 'thread', 'binding'].map(id =>
    action('register_item', { token_id: id, name: id, version: '1', bootstrap_cap: '10000' }, '0', '20000000000000')),
]);
for (const ids of [['salt', 'resin', 'salve', 'ward'], ['iron', 'thread']]) {
  batch(core, ids.map(id => action('bootstrap_item', { claim_id: 'setup-' + id + '-v1', receiver_id: owner,
    token_id: id, amount: id === 'salve' || id === 'ward' ? '10' : '100' })));
}
batch(core, [
  action('register_recipe', { recipe_id: 'apothecary-ward-v1', recipe: { input_ids: ['salt', 'resin'],
    input_amounts: ['2', '1'], output_id: 'ward', output_amount: '1', copper_cost: '400' } }),
  action('register_recipe', { recipe_id: 'relicsmith-inlay-v1', recipe: { input_ids: ['iron', 'resin'],
    input_amounts: ['2', '1'], output_id: 'relic-inlay', output_amount: '1', copper_cost: '600' } }),
  action('register_recipe', { recipe_id: 'binder-binding-v1', recipe: { input_ids: ['thread', 'resin'],
    input_amounts: ['2', '1'], output_id: 'binding', output_amount: '1', copper_cost: '500' } }),
]);
// Exact required factory funding is code bytes + 4000 vault bytes + 5000 registry bytes, at 10^19 yocto/byte.
const artifactFunding = String(BigInt(vault.length + 9000) * 10000000000000000000n);
for (const [token_id, kind, holder] of [['starter-001', 'RELIC', core], ['shop-001', 'SHOP_CHARTER', owner]]) {
  batch(core, [action('create_artifact', { token_id, kind, owner_id: holder,
    metadata: { title: token_id === 'starter-001' ? 'Ferryman Starter Relic' : 'Orchard Supply Shop' },
    vault_wasm: vault.toString('base64') }, artifactFunding, '150000000000000')]);
}
batch(core, [action('configure_starter', { configuration: { copper: '1000',
  token_ids: ['salve', 'ward'], quantities: ['1', '1'], grant_cap: '1' } })]);
const plan = { ...deployed, phase: 'setup', status: 'UNSIGNED', batches,
  description: 'Bootstrap 1000 Copper into game custody, register eight item types and three recipes, create a starter Relic and Shop vault, then configure one Guest starter slot.' };
await writeFile(new URL('deployments/testnet.setup.unsigned.json', root), JSON.stringify(plan, null, 2), { flag: 'wx' });
const attached = batches.flatMap(b => b.actions).reduce((sum, a) => sum + BigInt(a.params.deposit), 0n);
console.log(JSON.stringify({ batches: batches.length, attachedYocto: String(attached), artifactFundingYocto: artifactFunding }, null, 2));
