import { readFile, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { openFinalRewardSnapshot, reconcileRewardReservation } from '../server/src/economy/reward-reconciliation.mjs';

try {
  const { values } = parseArgs({
    options: { db: { type: 'string' }, run: { type: 'string' }, config: { type: 'string' }, apply: { type: 'boolean' } },
  });
  if (!values.db || !/^[A-Za-z0-9][A-Za-z0-9_:.-]{0,95}$/.test(values.run ?? '')) {
    throw new Error('Usage: node scripts/reconcile-checkpoint-rewards.mjs --db PATH --run RUN_ID [--config PATH] [--apply]');
  }
  if (!(await stat(values.db)).isFile()) throw new Error('Expected an existing SQLite reward database');
  const config = JSON.parse(await readFile(values.config ??
    new URL('../deployments/testnet.config.json', import.meta.url), 'utf8'));
  const snapshot = await openFinalRewardSnapshot(config);
  const result = await reconcileRewardReservation(values.db, { runId: values.run, snapshot, apply: values.apply });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
