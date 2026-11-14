import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canDeliverContract } from '../../../shared/map-generator.mjs';

export function openFieldContracts(file, { runs, funder, now = Date.now, offers = [] }) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS field_contracts (id TEXT PRIMARY KEY, account TEXT NOT NULL, payload TEXT NOT NULL)');
  const lookup = db.prepare('SELECT payload FROM field_contracts WHERE id = ? AND account = ?');
  const listForRun = db.prepare("SELECT payload FROM field_contracts WHERE account = ? AND json_extract(payload, '$.runId') = ? ORDER BY rowid");
  const save = db.prepare('INSERT INTO field_contracts VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload');
  const active = db.prepare("SELECT count(*) AS total FROM field_contracts WHERE account = ? AND json_extract(payload, '$.runId') = ? AND json_extract(payload, '$.status') IN ('reserving','accepted','paying','releasing')");
  const due = db.prepare("SELECT id, account FROM field_contracts WHERE json_extract(payload, '$.status') IN ('paying','releasing') OR (json_extract(payload, '$.status') IN ('reserving','accepted') AND json_extract(payload, '$.endsAt') <= ?) ORDER BY rowid LIMIT ?");
  const awaiting = db.prepare("SELECT rowid, id, account, json_extract(payload, '$.runId') AS runId FROM field_contracts WHERE rowid > ? AND json_extract(payload, '$.status') IN ('reserving','accepted') AND json_extract(payload, '$.endsAt') > ? ORDER BY rowid LIMIT ?");
  let recoveryCursor = 0;
  const queues = new Map();
  function write(row) { save.run(row.id, row.accountId, JSON.stringify(row)); return structuredClone(row); }
  function load(account, id) {
    const stored = lookup.get(id, account);
    if (!stored) throw new Error('contract_missing');
    return JSON.parse(stored.payload);
  }
  async function serialized(id, work) {
    const previous = queues.get(id) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(work);
    queues.set(id, pending);
    try { return await pending; }
    finally { if (queues.get(id) === pending) queues.delete(id); }
  }
  async function settle(row, action, nextStatus) {
    if (!funder?.[action]) throw new Error('contract_funder_unavailable');
    const operationId = row.id + ':' + action;
    const receipt = await funder[action]({
      operationId, reservationId: row.id, accountId: row.accountId, amountAtomic: row.rewardAtomic,
      endsAt: row.endsAt, reservation: row.reservation ?? null, evidence: row.evidence ?? null,
    });
    if (receipt?.status !== 'final' || receipt.operationId !== operationId) throw new Error('contract_settlement_pending');
    if (action === 'reserve') row.reservation = receipt;
    row.status = nextStatus;
    row.receipt = receipt;
    return write(row);
  }
  function completionEvidence(row, run) {
    const clear = run.observations.find(event => event.kind === 'encounter-clear' &&
      event.node === row.objective && event.sequence > row.acceptedVersion);
    const checkpoint = clear && run.observations.find(event => event.kind === 'checkpoint' &&
      event.node === row.delivery && event.sequence > clear.sequence);
    return checkpoint ? { clearSequence: clear.sequence, checkpointSequence: checkpoint.sequence, tradable: false } : null;
  }
  const service = {
    offers() { return structuredClone(offers.filter(offer => offer.endsAt > now())); },
    get: load,
    async forRun(accountId, runId) {
      const evidence = await runs.verifyProgress(accountId, runId);
      const contracts = listForRun.all(accountId, runId).map(row => JSON.parse(row.payload));
      const available = evidence.mode === 'expedition' && !['complete', 'defeat'].includes(evidence.state.phase);
      const eligible = available ? service.offers().filter(offer =>
        !contracts.some(contract => (contract.offerId ? contract.offerId === offer.id : contract.objective === offer.objective && contract.delivery === offer.delivery)) &&
        canDeliverContract(evidence.graph, evidence.state.node, offer.objective, offer.delivery)) : [];
      return { enabled: true, offers: eligible, contracts: contracts.map(contract => ({
        ...contract,
        canDeliver: contract.status === 'accepted' && contract.endsAt > now() && Boolean(completionEvidence(contract, evidence)),
      })) };
    },
    async accept(accountId, { runId, offerId }) {
      const id = createHash('sha256').update(JSON.stringify([accountId, runId, offerId])).digest('hex');
      return serialized(id, async () => {
        if (lookup.get(id, accountId)) {
          const prior = load(accountId, id);
          return prior.status === 'reserving' ? settle(prior, 'reserve', 'accepted') : prior;
        }
        const offer = offers.find(row => row.id === offerId);
        if (!offer || offer.endsAt <= now() || !/^[1-9]\d*$/.test(offer.rewardAtomic)) throw new Error('contract_unavailable');
        const evidence = await runs.verifyProgress(accountId, runId);
        if (evidence.mode !== 'expedition' || ['complete', 'defeat'].includes(evidence.state.phase)) throw new Error('contract_ineligible');
        if (!canDeliverContract(evidence.graph, evidence.state.node, offer.objective, offer.delivery)) throw new Error('contract_unreachable');
        const row = { ...offer, offerId: offer.id, id, accountId, runId, acceptedVersion: evidence.version, status: 'reserving' };
        if (!funder?.reserve) throw new Error('contract_funder_unavailable');
        db.exec('BEGIN IMMEDIATE');
        try {
          if (lookup.get(id, accountId)) {
            const stored = load(accountId, id);
            db.exec('COMMIT');
            return stored.status === 'reserving' ? settle(stored, 'reserve', 'accepted') : stored;
          }
          if (active.get(accountId, runId).total >= 2) throw new Error('contract_active_limit');
          write(row);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        return settle(row, 'reserve', 'accepted');
      });
    },
    async deliver(accountId, id) {
      return serialized(id, async () => {
        const row = load(accountId, id);
        if (row.status === 'paid') return row;
        if (row.status === 'paying') return settle(row, 'pay', 'paid');
        if (row.endsAt <= now()) throw new Error('contract_expired');
        if (row.status !== 'accepted') throw new Error('contract_unavailable');
        const evidence = await runs.verifyProgress(accountId, row.runId);
        const completion = completionEvidence(row, evidence);
        if (!completion) throw new Error('objective_incomplete');
        row.evidence = completion;
        row.status = 'paying';
        write(row);
        return settle(row, 'pay', 'paid');
      });
    },
    async settleCompleted(accountId, runId) {
      const rows = listForRun.all(accountId, runId).map(row => JSON.parse(row.payload))
        .filter(row => row.status === 'accepted' && row.endsAt > now());
      if (!rows.length) return;
      const proof = await runs.verifyProgress(accountId, runId);
      await Promise.allSettled(rows.filter(row => completionEvidence(row, proof))
        .map(row => service.deliver(accountId, row.id)));
    },
    async cancel(accountId, id) {
      return serialized(id, async () => {
        const row = load(accountId, id);
        if (row.status === 'cancelled' || row.status === 'expired') return row;
        if (row.status !== 'accepted' && row.status !== 'releasing') throw new Error('contract_not_cancellable');
        if (row.status === 'accepted') {
          row.status = 'releasing';
          row.releaseReason = row.endsAt <= now() ? 'expired' : 'cancelled';
          write(row);
        }
        return settle(row, 'release', row.releaseReason ?? 'expired');
      });
    },
    async recover(accountId, id) {
      return serialized(id, async () => {
        const row = load(accountId, id);
        if (row.status === 'paying') {
          try { return await settle(row, 'pay', 'paid'); }
          catch (error) {
            if (error.message !== 'field_payment_expired') throw error;
            row.status = 'releasing';
            row.releaseReason = 'expired';
            write(row);
          }
        }
        if (row.status === 'reserving') {
          try { await settle(row, 'reserve', 'accepted'); }
          catch (error) {
            if (error.message !== 'field_reservation_expired_without_funding') throw error;
            row.status = 'expired';
            return write(row);
          }
        }
        if (row.endsAt <= now() && row.status === 'accepted') {
          row.status = 'releasing';
          write(row);
        }
        return row.status === 'releasing' ? settle(row, 'release', row.releaseReason ?? 'expired') : row;
      });
    },
    async recoverDue(limit = 10) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_recovery_limit');
      const result = [];
      for (const row of due.all(now(), limit)) {
        try { result.push(await service.recover(row.account, row.id)); }
        catch { result.push({ id: row.id, status: 'pending' }); }
      }
      const waiting = awaiting.all(recoveryCursor, now(), limit);
      recoveryCursor = waiting.length === limit ? waiting.at(-1).rowid : 0;
      const runsToCheck = new Map();
      for (const row of waiting) {
        try {
          if (load(row.account, row.id).status === 'reserving') await service.recover(row.account, row.id);
          runsToCheck.set(JSON.stringify([row.account, row.runId]), row);
        } catch { result.push({ id: row.id, status: 'pending' }); }
      }
      await Promise.allSettled([...runsToCheck.values()].map(row => service.settleCompleted(row.account, row.runId)));
      return result;
    },
    close() { db.close(); },
  };
  return service;
}




