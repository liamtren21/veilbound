import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createRunService } from '../../server/src/runs/service.mjs';
import { createPostgresRunRepository } from '../../server/src/runs/repository.mjs';

const connectionString = process.env.VEILBOUND_TEST_PG;

test('PostgreSQL serializes competing actions and resumes through a new pool', { skip: !connectionString }, async () => {
  const { default: pg } = await import('../../server/node_modules/pg/lib/index.js');
  const playerId = randomUUID();
  const pool = new pg.Pool({ connectionString });
  const restarted = new pg.Pool({ connectionString });
  try {
    const migration = await readFile(new URL('../../server/migrations/001_run_accounts.sql', import.meta.url), 'utf8');
    await pool.query(migration);
    const runs = createRunService({ repository: createPostgresRunRepository(pool) });
    const another = createRunService({ repository: createPostgresRunRepository(restarted) });
    const [first, second] = await Promise.all([runs.start(playerId), another.start(playerId)]);
    assert.deepEqual(first, second);
    const request = { operationId: 'one', expectedVersion: 0, intent: { type: 'event', choice: 'enter' } };
    const results = await Promise.allSettled([
      runs.act(playerId, first.runId, request),
      another.act(playerId, first.runId, { ...request, operationId: 'two' }),
    ]);
    const applied = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(result => result.status === 'rejected');
    assert.equal(applied.length, 1);
    assert.equal(rejected[0].reason.code, 'STALE_VERSION');
    const winningRequest = results[0].status === 'fulfilled' ? request : { ...request, operationId: 'two' };
    assert.deepEqual(await another.act(playerId, first.runId, winningRequest), applied[0].value);
    await pool.end();
    assert.deepEqual(await another.get(playerId, first.runId), applied[0].value);
    assert.equal((await another.replay(playerId, first.runId)).events.length, 1);
  } finally {
    await restarted.query('DELETE FROM game_run_accounts WHERE account_id = $1', [playerId]).catch(() => {});
    if (!pool.ended) await pool.end();
    await restarted.end();
  }
});
