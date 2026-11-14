import test from 'node:test';
import assert from 'node:assert/strict';
import { openNpcScheduler } from '../../server/src/npc/scheduler.mjs';
import { createSignedActionAdapter } from '../../server/src/npc/executor.mjs';

const context = () => ({
  policy: { epoch: 1, expiresAt: 1000, methods: ['buy'], itemIds: ['salt'], maxQuantity: 2,
    maxUnitPriceAtomic: '20', budgetRemainingAtomic: '40', targetStock: { salt: 2 } },
  snapshot: { epoch: 1, availableAtomic: '40', stock: {} },
});
const proposal = { method: 'buy', itemId: 'salt', quantity: 2, unitPriceAtomic: '20', quoteExpiresAt: 900 };

test('NPC job survives restart and reconciles an uncertain signed send before any retry', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(join(tmpdir(), 'npc-scheduler-'));
  const file = join(directory, 'jobs.sqlite');
  let sends = 0;
  let finalized = null;
  const adapter = {
    readContext: async () => context(),
    prepare: async ({ operationId, action }) => ({ operationId, action }),
    findFinal: async () => finalized,
    submit: async () => { sends++; finalized = { status: 'final', receiptId: 'final-receipt', transactionHash: 'tx' }; throw new Error('rpc_timeout'); },
  };
  let scheduler = openNpcScheduler(file, { adapter, now: () => 100 });
  try {
    await scheduler.enqueue({ id: 'job-1', accountId: 'alice', proposal });
    assert.equal((await scheduler.run('job-1')).status, 'uncertain');
    scheduler.close();
    scheduler = openNpcScheduler(file, { adapter, now: () => 101 });
    assert.equal((await scheduler.run('job-1')).status, 'final');
    assert.equal((await scheduler.run('job-1')).status, 'final');
    assert.equal(sends, 1);
  } finally {
    scheduler.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('NPC executor revalidates owner epochs and never executes a stale grant', async () => {
  let epoch = 1;
  let sent = 0;
  const adapter = {
    readContext: async () => ({ ...context(), snapshot: { ...context().snapshot, epoch } }),
    prepare: async job => job,
    submit: async () => { sent++; return { status: 'final', receiptId: 'receipt' }; },
    findFinal: async () => null,
  };
  const scheduler = openNpcScheduler(':memory:', { adapter, now: () => 100 });
  try {
    await scheduler.enqueue({ id: 'epoch-job', accountId: 'alice', proposal });
    epoch = 2;
    assert.equal((await scheduler.run('epoch-job')).status, 'rejected');
    assert.equal(sent, 0);
  } finally { scheduler.close(); }
});

test('competing scheduler handles claim one job and maintain persisted operation identity', async () => {
  let sends = 0;
  let unblock;
  const latch = new Promise(resolve => { unblock = resolve; });
  const adapter = {
    readContext: async () => context(),
    prepare: async job => job,
    findFinal: async () => null,
    submit: async () => { sends++; await latch; return { status: 'final', receiptId: 'receipt' }; },
  };
  const scheduler = openNpcScheduler(':memory:', { adapter, now: () => 100 });
  try {
    await scheduler.enqueue({ id: 'race-job', accountId: 'alice', proposal });
    const first = scheduler.run('race-job');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await scheduler.run('race-job')).status, 'submitting');
    unblock();
    assert.equal((await first).status, 'final');
    assert.equal(sends, 1);
    await assert.rejects(scheduler.enqueue({ id: 'race-job', accountId: 'alice', proposal: { ...proposal, quantity: 1 } }), /job_conflict/);
  } finally { scheduler.close(); }
});

test('signed action adapter checks receiver and method before invoking the supplied signer', async () => {
  let signed = 0;
  const executor = createSignedActionAdapter({
    receiverId: 'core.demo.testnet', methods: ['fill_market_order'],
    readContext: async () => context(),
    prepare: async ({ operationId }) => ({ receiverId: 'attacker.testnet',
      actions: [{ type: 'FunctionCall', params: { methodName: 'withdraw', args: { operation_id: operationId }, gas: '100', deposit: '1' } }] }),
    findFinal: async () => null,
    signAndSend: async () => { signed++; },
  });
  await assert.rejects(executor.prepare({ operationId: 'operation', accountId: 'alice', action: proposal }), /transaction_outside_policy/);
  assert.equal(signed, 0);
});

import { createArtifactCraftAdapter } from '../../server/src/npc/relic-jobs.mjs';

test('artifact job preparation binds the existing policy operator, recipe, epoch and material snapshot', async () => {
  let material = '3';
  let sent = null;
  const chain = {
    async readArtifactContext() {
      return {
        blockHash: 'block-final',
        artifact: { epoch: '3', status: 'ready', transfer_pending: false },
        policy: { epoch: '3', operator: 'operator.demo.testnet', recipe_id: 'ward-v1',
          max_jobs: '2', completed: '0', copper_budget: '40', spent: '0', expires_at_ns: '1000000000' },
        recipe: { input_ids: ['salt'], input_amounts: ['2'], output_id: 'ward', output_amount: '1', copper_cost: '20' },
        balance: { available: '40' },
        inputs: { salt: { available: material } },
        sale: null,
      };
    },
    async getFinalArtifactJob() { return null; },
  };
  const adapter = createArtifactCraftAdapter({
    coreId: 'core.demo.testnet', operatorId: 'operator.demo.testnet', chain, now: () => 100,
    signAndSend: async request => { sent = request; return { status: 'final', receiptId: 'artifact-receipt' }; },
  });
  const scheduler = openNpcScheduler(':memory:', { adapter, now: () => 100 });
  try {
    await scheduler.enqueue({ id: 'artifact-job', accountId: 'relic-1',
      proposal: { method: 'craft', itemId: 'ward', quantity: 1, unitPriceAtomic: '20', quoteExpiresAt: 500 } });
    assert.equal((await scheduler.run('artifact-job')).status, 'final');
    assert.equal(sent.transaction.actions[0].params.methodName, 'execute_artifact_craft');
    assert.equal(sent.transaction.actions[0].params.args.token_id, 'relic-1');
    assert.equal(sent.transaction.actions[0].params.args.expected_epoch, '3');
    assert.equal(sent.transaction.actions[0].params.args.expected_recipe_id, 'ward-v1');
    material = '0';
    await assert.rejects(scheduler.enqueue({ id: 'artifact-next', accountId: 'relic-1',
      proposal: { method: 'craft', itemId: 'ward', quantity: 1, unitPriceAtomic: '20', quoteExpiresAt: 500 } }), /insufficient_artifact_inputs/);
  } finally { scheduler.close(); }
});


test('NPC rejects non-finite clocks and reserves pending jobs against one shared budget', async () => {
  const adapter = { readContext: async () => context(), prepare: async job => job, submit: async () => null, findFinal: async () => null };
  const scheduler = openNpcScheduler(':memory:', { adapter, now: () => 100 });
  try {
    await assert.rejects(scheduler.enqueue({ id: 'bad-time', accountId: 'alice', proposal: { ...proposal, quoteExpiresAt: NaN } }), /invalid_quote/);
    await scheduler.enqueue({ id: 'reserved-first', accountId: 'alice', proposal });
    await assert.rejects(scheduler.enqueue({ id: 'reserved-second', accountId: 'alice', proposal }), /reserved_budget/);
  } finally { scheduler.close(); }
});



import { createArtifactJobViews } from '../../server/src/chain/artifact-jobs.mjs';

test('artifact view adapter pins every balance and policy read to one finalized block', async () => {
  const reads = [];
  const values = {
    get_artifact: { vault_id: 'vault.demo.testnet' },
    get_artifact_policy: { recipe_id: 'ward-v1' },
    get_nft_sale: null,
    get_recipe: { input_ids: ['salt'] },
    get_balance: { available: '20' },
    get_item_balance: { available: '2' },
    get_artifact_job_receipt: 'ward-v1',
  };
  const chain = createArtifactJobViews({
    coreId: 'core.demo.testnet',
    transport: async (_url, options) => {
      const request = JSON.parse(options.body);
      if (request.method === 'block') return { ok: true, json: async () => ({ result: { header: { hash: 'final-hash' } } }) };
      reads.push(request.params);
      return { ok: true, json: async () => ({ result: { block_hash: 'final-hash',
        result: [...Buffer.from(JSON.stringify(values[request.params.method_name]))] } }) };
    },
  });
  const result = await chain.readArtifactContext('relic-1');
  assert.equal(result.inputs.salt.available, '2');
  assert.deepEqual(await chain.getFinalArtifactJob('relic-1', 'npc-operation'), { blockHash: 'final-hash', recipeId: 'ward-v1' });
  assert.ok(reads.every(params => params.block_id === 'final-hash'));
});

