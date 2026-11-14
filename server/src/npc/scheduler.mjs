import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { validateProposal } from './policy.mjs';

const identifier = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,95}$/;
const terminal = new Set(['final', 'failed', 'rejected', 'cancelled']);
const reserving = new Set(['queued', 'preparing', 'submitting', 'uncertain']);
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function finalResult(result) {
  return result?.status === 'final' && typeof result.receiptId === 'string' && result.receiptId.length > 0;
}

export function openNpcScheduler(file, { adapter, now = Date.now, leaseMs = 30_000, fundedMarket = false } = {}) {
  if (!adapter || ['readContext', 'prepare', 'submit', 'findFinal'].some(method => typeof adapter[method] !== 'function')) {
    throw new Error('npc_adapter_required');
  }
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new Error('invalid_job_lease');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS npc_jobs (id TEXT PRIMARY KEY, document TEXT NOT NULL)');
  const read = db.prepare('SELECT document FROM npc_jobs WHERE id = ?');
  const write = db.prepare(`
    INSERT INTO npc_jobs (id, document) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET document = excluded.document
  `);
  const all = db.prepare('SELECT document FROM npc_jobs');
  const get = id => {
    const row = read.get(id);
    if (!row) throw new Error('npc_job_missing');
    return JSON.parse(row.document);
  };
  const transaction = callback => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const save = job => {
    write.run(job.id, JSON.stringify(job));
    return clone(job);
  };
  const update = (id, token, callback) => transaction(() => {
    const job = get(id);
    if (job.leaseToken !== token) return clone(job);
    callback(job);
    job.updatedAt = now();
    return save(job);
  });
  const reconcile = async job => {
    try {
      const result = await adapter.findFinal(clone(job));
      return update(job.id, job.leaseToken, current => {
        if (finalResult(result)) {
          current.status = 'final';
          current.receipt = clone(result);
          delete current.error;
        } else if (result?.status === 'failed' && result.receiptId) {
          current.status = 'failed';
          current.receipt = clone(result);
        } else current.status = 'uncertain';
        current.leaseUntil = 0;
      });
    } catch {
      return update(job.id, job.leaseToken, current => {
        current.status = 'uncertain';
        current.leaseUntil = 0;
        current.error = 'reconciliation_unavailable';
      });
    }
  };
  return {
    async enqueue({ id, accountId, proposal }) {
      if (typeof id !== 'string' || !identifier.test(id) || typeof accountId !== 'string' ||
          !identifier.test(accountId)) throw new Error('invalid_npc_job');
      const context = await adapter.readContext({ accountId });
      const action = validateProposal({ proposal, ...context, now: now() });
      const authorityFingerprint = hash(context.authority ?? null);
      const fingerprint = hash({ accountId, action, authorityFingerprint });
      return transaction(() => {
        const prior = read.get(id);
        if (prior) {
          const job = JSON.parse(prior.document);
          if (job.fingerprint !== fingerprint) throw new Error('npc_job_conflict');
          return clone(job);
        }
        const accountJobs = all.all().map(row => JSON.parse(row.document)).filter(job => job.accountId === accountId);
        const reservations = accountJobs.filter(job => job.action.epoch === action.epoch && reserving.has(job.status));
        if (fundedMarket) {
          const commitments = accountJobs.filter(job => reserving.has(job.status) || job.status === 'final');
          if (commitments.some(job => job.action.itemId === action.itemId &&
              (reserving.has(job.status) || job.action.quoteExpiresAt > now()))) {
            throw new Error('npc_market_order_pending');
          }
          const committed = commitments.reduce((total, job) => total + BigInt(job.action.costAtomic), 0n);
          if (committed + BigInt(action.costAtomic) > BigInt(context.policy.budgetRemainingAtomic)) {
            throw new Error('npc_market_commitment_cap');
          }
        }
        const reserved = reservations.filter(job => job.action.method !== 'sell')
          .reduce((total, job) => total + BigInt(job.action.costAtomic), 0n);
        const allCosts = reservations.reduce((total, job) => total + BigInt(job.action.costAtomic), 0n);
        if (allCosts + BigInt(action.costAtomic) > BigInt(context.policy.budgetRemainingAtomic) ||
            action.method !== 'sell' && reserved + BigInt(action.costAtomic) > BigInt(context.snapshot.availableAtomic)) {
          throw new Error('npc_reserved_budget_exceeded');
        }
        if (action.method === 'sell') {
          const stockReserved = reservations.filter(job => job.action.method === 'sell' && job.action.itemId === action.itemId)
            .reduce((total, job) => total + job.action.quantity, 0);
          if (stockReserved + action.quantity > (context.snapshot.stock[action.itemId] ?? 0)) {
            throw new Error('npc_reserved_stock_exceeded');
          }
        }
        return save({ id, operationId: 'npc-' + hash({ id, accountId }).slice(0, 60), accountId, action,
          fingerprint, authority: clone(context.authority ?? null), authorityFingerprint, status: 'queued', createdAt: now(), updatedAt: now(), leaseUntil: 0 });
      });
    },
    get: id => clone(get(id)),
    publishableMarketOrders(accountId) {
      return all.all().map(row => JSON.parse(row.document)).filter(job => job.accountId === accountId &&
        job.status === 'final' && !job.marketPublished && job.transactionHash && job.action.quoteExpiresAt > now());
    },
    markMarketPublished(id) {
      transaction(() => {
        const job = get(id);
        job.marketPublished = true;
        save(job);
      });
    },
    expiredMarketOrders(accountId) {
      return all.all().map(row => JSON.parse(row.document)).filter(job => job.accountId === accountId &&
        job.status === 'final' && !job.escrowReleased && job.action.quoteExpiresAt <= now());
    },
    markEscrowReleased(id) {
      transaction(() => {
        const job = get(id);
        job.escrowReleased = true;
        save(job);
      });
    },
    async run(id) {
      const token = randomUUID();
      const claimed = transaction(() => {
        const job = get(id);
        if (terminal.has(job.status) || job.leaseUntil > now()) return { acquired: false, job };
        const recovery = ['submitting', 'uncertain'].includes(job.status);
        job.leaseToken = token;
        job.leaseUntil = now() + leaseMs;
        if (!recovery) job.status = 'preparing';
        save(job);
        return { acquired: true, recovery, job };
      });
      if (!claimed.acquired) return clone(claimed.job);
      const { job } = claimed;
      if (claimed.recovery) return reconcile(job);
      try {
        const context = await adapter.readContext({ accountId: job.accountId });
        const current = validateProposal({ proposal: job.action, ...context, now: now() });
        if (hash(context.authority ?? null) !== job.authorityFingerprint || hash(current) !== hash(job.action)) throw new Error('npc_job_policy_changed');
        const prepared = await adapter.prepare({ ...clone(job), action: current });
        const submission = update(id, token, latest => {
          if (latest.leaseUntil <= now()) throw new Error('npc_job_lease_expired');
          if (current.quoteExpiresAt <= now()) throw new Error('invalid_quote');
          latest.prepared = clone(prepared);
          latest.status = 'submitting';
        });
        if (submission.leaseToken !== token || submission.status !== 'submitting') return submission;
        let result;
        try {
          result = await adapter.submit(clone(submission));
        } catch {
          return update(id, token, latest => {
            latest.status = 'uncertain';
            latest.leaseUntil = 0;
            latest.error = 'submission_result_unknown';
          });
        }
        return update(id, token, latest => {
          if (finalResult(result)) {
            latest.status = 'final';
            latest.receipt = clone(result);
          } else {
            latest.status = 'uncertain';
            if (result?.transactionHash) latest.transactionHash = result.transactionHash;
          }
          latest.leaseUntil = 0;
        });
      } catch (error) {
        return update(id, token, latest => {
          latest.status = 'rejected';
          latest.leaseUntil = 0;
          latest.error = /^[a-z_]{1,80}$/.test(error.message) ? error.message : 'job_validation_failed';
        });
      }
    },
    cancel(id, accountId) {
      return transaction(() => {
        const job = get(id);
        if (job.accountId !== accountId) throw new Error('npc_job_missing');
        if (job.status !== 'queued') throw new Error('npc_job_not_cancellable');
        job.status = 'cancelled';
        job.updatedAt = now();
        return save(job);
      });
    },
    async tick({ limit = 10 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_tick_limit');
      const jobs = all.all().map(row => JSON.parse(row.document))
        .filter(job => !terminal.has(job.status) && job.leaseUntil <= now())
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
        .slice(0, limit);
      const result = [];
      for (const job of jobs) result.push(await this.run(job.id));
      return result;
    },
    close: () => db.close(),
  };
}


