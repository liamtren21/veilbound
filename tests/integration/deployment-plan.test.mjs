import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeDeploymentPlan } from '../../scripts/lib/deployment.mjs';

const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const config = {
  network: 'testnet', rootAccountId: 'veilbound-demo.testnet',
  receiptSigner: Buffer.alloc(32, 1).toString('base64'),
  ruleset: 'veilbound-v1', bootstrapCap: '1000000', globalRewardCap: '1000000',
  epochLengthNs: '86400000000000', epochRewardCap: '100000',
  copperFundingYocto: '5000000000000000000000000',
  coreFundingYocto: '5000000000000000000000000',
};

test('deployment creates bounded atomic deployment batches and leaves Core paused', () => {
  const plan = makeDeploymentPlan(config, { copper: wasm, core: wasm, vault: wasm });
  assert.equal(plan.network, 'testnet');
  assert.equal(plan.batches.length, 3);
  const copper = plan.batches[0];
  assert.equal(copper.receiverId, 'copper.veilbound-demo.testnet');
  assert.deepEqual(copper.actions.map(a => a.type), ['CreateAccount', 'Transfer', 'DeployContract', 'FunctionCall']);
  assert.equal(copper.actions.at(-1).params.args.core_id, 'core.veilbound-demo.testnet');
  assert.equal(plan.batches[2].actions[0].params.methodName, 'pin_vault_template');
  assert.ok(plan.artifacts.vault.sha256);
  assert.throws(() => makeDeploymentPlan({ ...config, network: 'mainnet' }, { copper: wasm, core: wasm, vault: wasm }));
  assert.throws(() => makeDeploymentPlan({ ...config, receiptSigner: 'bad' }, { copper: wasm, core: wasm, vault: wasm }));
  assert.throws(() => makeDeploymentPlan(config, { copper: Buffer.from('bad'), core: wasm, vault: wasm }));
});
