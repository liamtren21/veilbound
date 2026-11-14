import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker } from 'near-workspaces';

const wasm = name => fileURLToPath(new URL('../../contracts/target/wasm32-unknown-unknown/release/veilbound_' + name + '.wasm', import.meta.url));
test('Guest starter locks backed Copper and relic, links once and claims once', async t => {
  const worker = await Worker.init();
  t.after(() => worker.tearDown());
  const root = worker.rootAccount;
  const copper = await root.createSubAccount('copper');
  const core = await root.createSubAccount('core');
  const alice = await root.createSubAccount('alice');
  const bob = await root.createSubAccount('bob');
  const deployed = JSON.parse(await readFile(new URL('../../deployments/testnet.unsigned.json', import.meta.url)));
  for (const [name, account] of [['copper', copper], ['core', core]]) {
    const batch = deployed.batches.find(row => row.receiverId === deployed.contracts[name]);
    const original = Buffer.from(batch.actions.find(action => action.type === 'DeployContract').params.code, 'base64');
    assert.equal(createHash('sha256').update(original).digest('hex'), deployed.artifacts[name].sha256);
    await account.deploy(original);
  }
  await root.call(copper, 'new', { owner_id: root.accountId, core_id: core.accountId,
    bootstrap_cap: '2000', global_reward_cap: '1000', epoch_length_ns: '10000000000000000000', epoch_reward_cap: '1000' });
  await root.call(core, 'new', { owner_id: root.accountId, copper_id: copper.accountId,
    receipt_signer: Buffer.alloc(32, 1).toString('base64'), ruleset: 'starter-v1' });
  const gas = '150000000000000';
  const storage = { attachedDeposit: '100000000000000000000000' };
  await root.call(copper, 'storage_deposit', { registration_only: true }, storage);
  await root.call(core, 'fund_storage', {}, storage);
  await root.call(copper, 'bootstrap', { claim_id: 'starter-pool', receiver_id: root.accountId, amount: '1000' });
  await root.call(copper, 'ft_transfer_call', { receiver_id: core.accountId, amount: '1000',
    msg: JSON.stringify({ operation_id: 'starter-deposit' }) }, { gas, attachedDeposit: '1' });
  await root.call(core, 'set_paused', { paused: false });
  const code = await readFile(wasm('vault'));
  await root.call(core, 'pin_vault_template', { code_hash: createHash('sha256').update(code).digest('base64') });
  await root.call(core, 'create_artifact', { token_id: 'guest-relic', owner_id: core.accountId,
    kind: 'RELIC', metadata: { title: 'Guest Starter' }, vault_wasm: code.toString('base64') },
  { gas, attachedDeposit: '3000000000000000000000000' });
  for (const id of ['salve', 'ward']) {
    await root.call(core, 'register_item', { token_id: id, name: id, version: '1', bootstrap_cap: '1' });
    await root.call(core, 'bootstrap_item', { claim_id: 'starter-' + id, receiver_id: root.accountId, token_id: id, amount: '1' });
  }
  await root.call(core, 'configure_starter', { configuration: { copper: '1000', token_ids: ['salve', 'ward'], quantities: ['1', '1'], grant_cap: '1' } });
  const grant = { grant_id: 'guest-1', relic_id: 'guest-relic' };
  await root.call(core, 'issue_starter', grant);
  const snapshot = async () => Promise.all([
    copper.view('ft_total_supply'), copper.view('ft_balance_of', { account_id: core.accountId }),
    core.view('get_balance', { account_id: root.accountId }), core.view('get_starter_grant', { grant_id: grant.grant_id }),
    core.view('nft_token', { token_id: grant.relic_id }),
  ]);
  const before = await snapshot();
  await root.call(core, 'set_paused', { paused: true });
  for (const [name, account] of [['copper', copper], ['core', core]]) {
    await root.call(account, 'upgrade', { wasm: (await readFile(wasm(name))).toString('base64') }, { gas: '200000000000000' });
  }
  assert.deepEqual(await snapshot(), before);
  assert.equal(await core.view('is_paused'), true);
  await root.call(core, 'set_paused', { paused: false });
  const originalStarter = await core.view('get_starter_configuration');
  await assert.rejects(bob.call(core, 'increase_starter_capacity', { new_cap: '2' }));
  await assert.rejects(root.call(core, 'increase_starter_capacity', { new_cap: '1' }));
  await root.call(core, 'increase_starter_capacity', { new_cap: '2' });
  assert.deepEqual(await core.view('get_starter_configuration'), { ...originalStarter, grant_cap: '2' });
  await root.call(core, 'issue_starter', grant);
  assert.equal((await core.view('get_starter_pool')).issued, '1');
  await root.call(core, 'issue_starter', grant);
  assert.deepEqual(await core.view('get_balance', { account_id: root.accountId }), { available: '0', reserved: '1000' });
  await assert.rejects(bob.call(core, 'link_starter', { grant_id: 'guest-1', account_id: bob.accountId }));
  await root.call(core, 'link_starter', { grant_id: 'guest-1', account_id: alice.accountId });
  await assert.rejects(root.call(core, 'link_starter', { grant_id: 'guest-1', account_id: bob.accountId }));
  await assert.rejects(bob.call(core, 'claim_starter', { grant_id: 'guest-1' }, { gas, attachedDeposit: '1' }));
  await alice.call(core, 'claim_starter', { grant_id: 'guest-1' }, { gas, attachedDeposit: '1' });
  await alice.call(core, 'claim_starter', { grant_id: 'guest-1' }, { gas, attachedDeposit: '1' });
  assert.deepEqual(await core.view('get_balance', { account_id: alice.accountId }), { available: '1000', reserved: '0' });
  assert.equal((await core.view('nft_token', { token_id: 'guest-relic' })).owner_id, alice.accountId);
  assert.equal(await copper.view('ft_balance_of', { account_id: core.accountId }), '1000');
  assert.equal(await core.view('mt_balance_of', { account_id: alice.accountId, token_id: 'salve' }), '1');
  await alice.call(core, 'fund_storage', {}, storage);
  await root.call(core, 'register_item', { token_id: 'potion', name: 'Potion', version: '1', bootstrap_cap: '1' });
  await root.call(core, 'register_recipe', { recipe_id: 'relic-potion-v1', recipe: {
    input_ids: ['salve'], input_amounts: ['1'], output_id: 'potion', output_amount: '1', copper_cost: '10',
  } });
  await alice.call(core, 'fund_artifact', { token_id: 'guest-relic', copper: '100', item_ids: ['salve'], amounts: ['1'] }, { gas, attachedDeposit: '1' });
  await alice.call(core, 'set_artifact_policy', { token_id: 'guest-relic', operator: bob.accountId,
    recipe_id: 'relic-potion-v1', max_jobs: '1', copper_budget: '10', expires_at_ns: '9000000000000000000' }, { gas, attachedDeposit: '1' });
  const oldEpoch = (await core.view('get_artifact', { token_id: 'guest-relic' })).epoch;
  const staleJob = { token_id: 'guest-relic', operation_id: 'potion-1', expected_epoch: oldEpoch, expected_recipe_id: 'relic-potion-v1' };
  await alice.call(core, 'set_artifact_policy', { token_id: 'guest-relic', operator: bob.accountId,
    recipe_id: 'relic-potion-v1', max_jobs: '1', copper_budget: '10', expires_at_ns: '9000000000000000000' }, { gas, attachedDeposit: '1' });
  await assert.rejects(bob.call(core, 'execute_artifact_craft', staleJob, { gas, attachedDeposit: '1' }));
  const job = { ...staleJob, expected_epoch: (await core.view('get_artifact', { token_id: 'guest-relic' })).epoch };
  await bob.call(core, 'execute_artifact_craft', job, { gas, attachedDeposit: '1' });
  assert.equal(await core.view('get_artifact_job_receipt', { token_id: 'guest-relic', operation_id: 'potion-1' }), 'relic-potion-v1');
  await bob.call(core, 'execute_artifact_craft', job, { gas, attachedDeposit: '1' });
  const artifact = await core.view('get_artifact', { token_id: 'guest-relic' });
  assert.equal(await core.view('mt_balance_of', { account_id: artifact.vault_id, token_id: 'potion' }), '1');
  assert.deepEqual(await core.view('get_balance', { account_id: artifact.vault_id }), { available: '90', reserved: '0' });
  await alice.call(core, 'nft_transfer', { token_id: 'guest-relic', receiver_id: bob.accountId }, { gas, attachedDeposit: '1' });
  await assert.rejects(bob.call(core, 'execute_artifact_craft', { ...job, operation_id: 'potion-2' }, { gas, attachedDeposit: '1' }));
  await assert.rejects(alice.call(core, 'set_artifact_policy', { token_id: 'guest-relic', operator: alice.accountId,
    recipe_id: 'relic-potion-v1', max_jobs: '1', copper_budget: '10', expires_at_ns: '9000000000000000000' }, { gas, attachedDeposit: '1' }));
  await bob.call(core, 'fund_storage', {}, storage);
  const retrieve = { token_id: 'guest-relic', operation_id: 'retrieve-1',
    expected_epoch: (await core.view('get_artifact', { token_id: 'guest-relic' })).epoch,
    copper: '90', item_ids: ['potion'], amounts: ['1'] };
  await assert.rejects(alice.call(core, 'withdraw_artifact', retrieve, { gas, attachedDeposit: '1' }));
  await assert.rejects(bob.call(core, 'withdraw_artifact', { ...retrieve, expected_epoch: oldEpoch }, { gas, attachedDeposit: '1' }));
  await bob.call(core, 'list_nft', { token_id: 'guest-relic', price: '100' }, { gas, attachedDeposit: '1' });
  await assert.rejects(bob.call(core, 'withdraw_artifact', retrieve, { gas, attachedDeposit: '1' }));
  await bob.call(core, 'cancel_nft_sale', { token_id: 'guest-relic' }, { gas, attachedDeposit: '1' });
  await bob.call(core, 'withdraw_artifact', retrieve, { gas, attachedDeposit: '1' });
  await bob.call(core, 'withdraw_artifact', retrieve, { gas, attachedDeposit: '1' });
  assert.equal(await core.view('get_artifact_policy', { token_id: 'guest-relic' }), null);
  assert.deepEqual(await core.view('get_balance', { account_id: artifact.vault_id }), { available: '0', reserved: '0' });
  assert.deepEqual(await core.view('get_balance', { account_id: bob.accountId }), { available: '90', reserved: '0' });
  assert.equal(await core.view('mt_balance_of', { account_id: bob.accountId, token_id: 'potion' }), '1');
  assert.equal(await core.view('get_total_allocated'), '1000');
  const chronicle = { token_id: 'guest-relic', entry_id: 'clear-3', player: alice.accountId,
    run_id: 'verified-run', ruleset: 'starter-v1', achievement: 'region-3-clear' };
  await assert.rejects(alice.call(core, 'record_chronicle', chronicle));
  await root.call(core, 'record_chronicle', chronicle);
  await root.call(core, 'record_chronicle', chronicle);
  const evolution = { token_id: 'guest-relic', stage: 1, required_entry_id: 'clear-3',
    media: 'ipfs://veilbound-test-upgraded', media_hash: Buffer.alloc(32, 2).toString('base64') };
  await root.call(core, 'register_evolution_recipe', { stage: 1, recipe: {
    item_ids: ['potion'], amounts: ['1'], copper_cost: '10', media: evolution.media, media_hash: evolution.media_hash,
  } });
  await assert.rejects(root.call(core, 'register_evolution_recipe', { stage: 1, recipe: {
    item_ids: ['potion'], amounts: ['1'], copper_cost: '1', media: evolution.media, media_hash: evolution.media_hash,
  } }));
  await assert.rejects(root.call(core, 'evolve_artifact_media', evolution, { gas, attachedDeposit: '1' }));
  await assert.rejects(bob.call(core, 'evolve_artifact_media', { ...evolution, media: 'ipfs://forged' }, { gas, attachedDeposit: '1' }));
  await bob.call(core, 'evolve_artifact_media', evolution, { gas, attachedDeposit: '1' });
  await bob.call(core, 'evolve_artifact_media', evolution, { gas, attachedDeposit: '1' });
  assert.equal(await core.view('mt_balance_of', { account_id: bob.accountId, token_id: 'potion' }), '0');
  assert.deepEqual(await core.view('get_balance', { account_id: bob.accountId }), { available: '80', reserved: '0' });
  assert.equal(await core.view('get_total_allocated'), '1000');
  assert.equal((await core.view('nft_token', { token_id: 'guest-relic' })).metadata.media, 'ipfs://veilbound-test-upgraded');
  assert.equal((await core.view('get_chronicle_entry', { token_id: 'guest-relic', entry_id: 'clear-3' })).player, alice.accountId);
});
