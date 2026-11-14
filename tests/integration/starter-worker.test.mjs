import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunService } from '../../server/src/runs/service.mjs';
import { openSqliteRunRepository } from '../../server/src/runs/repository.mjs';
import { openStarterGrants } from '../../server/src/economy/starter-grants.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, pendingEnemyDice } from '../../expedition-rules.mjs';
test('starter worker recovers ambiguous submission by final grant without allocating another relic', async () => {
  const grants = new Map();
  let issues = 0;
  const chain = {
    getFinalGrant: async id => grants.get(id),
    issue: async args => {
      issues++;
      grants.set(args.grant_id, { relic_id: args.relic_id, claimed: false, linked_account: null });
      throw new Error('connection_lost_after_submission');
    },
    link: async args => { grants.get(args.grant_id).linked_account = args.account_id; },
    claimTransaction: grantId => ({ grantId }),
  };
  const service = openStarterGrants(':memory:', { chain, relicIds: ['relic-1'] });
  try {
    await assert.rejects(service.provision('guest-1'), /connection_lost/);
    const result = await service.provision('guest-1');
    assert.equal(result.status, 'issued');
    assert.equal(issues, 1);
    assert.equal((await service.provision('guest-2')).reason, 'starter_pool_empty');
    const claim = await service.prepareClaim('guest-1', 'alice.testnet');
    assert.equal(claim.linkedAccount, 'alice.testnet');
    await assert.rejects(service.prepareClaim('guest-1', 'bob.testnet'), /starter_link_conflict/);
    grants.get(claim.grantId).claimed = true;
    assert.equal((await service.refreshStatus('guest-1')).status, 'claimed');
    assert.equal(service.status('guest-1').status, 'claimed');
    assert.equal((await service.prepareClaim('guest-1', 'alice.testnet')).transaction, undefined);
  } finally { service.close(); }
});

test('guest consumable spend survives a restart and claim waits for finalized settlement', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'veilbound-guest-spend-'));
  let grant;
  let spend;
  let writes = 0;
  let settleAvailable = false;
  const chain = {
    getFinalGrant: async () => grant,
    getFinalInventory: async () => ({ copper: '1000', token_ids: ['ward'], quantities: [spend ? '0' : '1'] }),
    getFinalSpend: async () => spend,
    settle: async ({ copper, quantities }) => {
      if (!settleAvailable) throw new Error('rpc_unavailable');
      writes++;
      spend = { copper, quantities };
      throw new Error('connection_lost_after_submission');
    },
    issue: async ({ relic_id }) => { grant = { relic_id, linked_account: null, claimed: false }; },
    link: async ({ account_id }) => { grant.linked_account = account_id; },
    claimTransaction: grantId => ({ grantId }),
  };
  function open() {
    const starter = openStarterGrants(join(directory, 'starter.sqlite'), { chain, relicIds: ['guest-relic'] });
    const repository = openSqliteRunRepository(join(directory, 'runs.sqlite'));
    const runs = createRunService({ repository, starter, entropy: size => Buffer.alloc(size, 2) });
    return { runs, starter, close() { runs.close(); starter.close(); } };
  }
  let instance = open();
  try {
    await instance.starter.provision('guest');
    let snapshot = await instance.runs.start('guest', { tutorial: true });
    assert.equal(snapshot.state.copper, 10);
    assert.equal(snapshot.state.pack['guard-token'], 1);
    const act = async intent => {
      snapshot = await instance.runs.act('guest', snapshot.runId, {
        expectedVersion: snapshot.version, operationId: 'action-' + snapshot.version, intent,
      });
    };
    await act({ type: 'event', choice: 'enter' });
    await act({ type: 'enter', node: 'road' });
    await act({ type: 'use-die', dieId: 'reserve', itemId: 'guard-token', round: 1 });
    assert.equal(snapshot.state.pack['guard-token'], 0);
    await assert.rejects(instance.runs.prepareStarterClaim('guest', 'alice.testnet'),
      { code: 'FINISH_ACTIVE_RUN_BEFORE_CLAIM' });
    assert.equal((await instance.runs.start('guest')).runId, snapshot.runId);
    for (let index = 0; snapshot.state.phase === 'battle' && index < 250; index++) {
      const { state } = snapshot;
      const [die] = pendingEnemyDice(state);
      if (die) {
        const plan = describe(state, die.id);
        await act({ type: 'use-die', dieId: die.id, round: state.battle.round,
          ...(plan.choose ? { targetKey: plan.targets[0].key } : {}) });
      } else {
        await act({ type: 'end-round', round: state.battle.round });
      }
    }
    assert.equal(snapshot.lifecycle, 'LOST');
    assert.equal(instance.runs.replay('guest', snapshot.runId).verified, true);
    instance.close();
    instance = open();
    await assert.rejects(instance.runs.prepareStarterClaim('guest', 'alice.testnet'), { code: 'STARTER_SPEND_PENDING' });
    assert.equal(grant.linked_account, null);
    await assert.rejects(async () => instance.runs.start('guest'), { code: 'STARTER_SPEND_PENDING' });
    settleAvailable = true;
    assert.ok((await instance.runs.prepareStarterClaim('guest', 'alice.testnet')).transaction);
    assert.deepEqual(spend, { copper: '0', quantities: ['1'] });
    assert.equal(writes, 1);
    assert.equal((await instance.runs.start('guest')).state.pack['guard-token'], 0);
  } finally {
    instance.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test('final starter custody equips the server run and claim preparation fences future runs', async () => {
  const grants = new Map();
  let now = 1000;
  let offline = false;
  let finishLink;
  const linkStarted = new Promise(resolve => { finishLink = resolve; });
  let releaseLink;
  const linkGate = new Promise(resolve => { releaseLink = resolve; });
  const chain = {
    getFinalGrant: async id => {
      if (offline) throw new Error('rpc_unavailable');
      return grants.get(id);
    },
    issue: async args => grants.set(args.grant_id, { relic_id: args.relic_id, claimed: false, linked_account: null }),
    link: async args => {
      finishLink();
      await linkGate;
      grants.get(args.grant_id).linked_account = args.account_id;
    },
    claimTransaction: grantId => ({ grantId }),
  };
  const starter = openStarterGrants(':memory:', { chain, relicIds: ['relic-1', 'relic-2'],
    now: () => now, cacheTtlMs: 100 });
  const repository = openSqliteRunRepository(':memory:');
  const runs = createRunService({ repository, starter });
  try {
    const pending = runs.start('pending-player');
    assert.equal(pending.state.starterRelic, undefined);
    await starter.provision('guest-1');
    await starter.provision('stale-player');
    offline = true;
    assert.equal((await starter.refreshStatus('guest-1')).status, 'issued');
    const run = runs.start('guest-1');
    assert.equal(run.state.starterRelic.relicId, 'relic-1');
    assert.equal(run.state.heroes.find(hero => hero.id === 'mara').equipment[0], 'ferryman-cord');
    assert.equal(runs.replay('guest-1', run.runId).verified, true);
    await assert.rejects(runs.prepareStarterClaim('guest-1', 'alice.testnet'),
      { code: 'FINISH_ACTIVE_RUN_BEFORE_CLAIM' });
    now += 101;
    assert.equal((await starter.refreshStatus('stale-player')).status, 'pending');
    assert.equal(runs.start('stale-player').state.starterRelic, undefined);
    offline = false;
    // Close the stored fixture to exercise the claim gate independently of combat.
    repository.update('guest-1', account => { account.runs[run.runId].state.phase = 'defeat'; });
    const claim = runs.prepareStarterClaim('guest-1', 'alice.testnet');
    await linkStarted;
    const next = runs.start('guest-1');
    assert.equal(next.state.starterRelic, undefined);
    releaseLink();
    assert.ok((await claim).transaction);
    assert.ok((await runs.prepareStarterClaim('guest-1', 'alice.testnet')).transaction);
  } finally {
    releaseLink();
    runs.close();
    starter.close();
  }
});
