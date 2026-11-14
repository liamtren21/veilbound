import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const atomic = value => typeof value === 'string' && /^(0|[1-9]\d{0,38})$/.test(value);

export async function openFinalRewardSnapshot(config, transport = fetch) {
  if (config.network !== 'testnet' || !/^[a-z0-9._-]+\.testnet$/.test(config.rootAccountId)) {
    throw new Error('Expected testnet reward deployment');
  }
  const contract = 'core.' + config.rootAccountId;
  const copper = 'copper.' + config.rootAccountId;
  async function rpc(method, params) {
    const response = await transport('https://test.rpc.fastnear.com', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 'reward-reconciliation', method, params }),
    });
    if (!response.ok) throw new Error('Reward RPC unavailable');
    const { error, result } = await response.json();
    if (error || result?.error || !result) throw new Error('Reward finalized snapshot unavailable');
    return result;
  }
  const { header } = await rpc('block', { finality: 'final' });
  if (typeof header?.hash !== 'string' || !header.hash || !atomic(header.timestamp_nanosec)) {
    throw new Error('Invalid finalized reward block');
  }
  async function view(account_id, method_name, args = {}) {
    const result = await rpc('query', { request_type: 'call_function', account_id, method_name,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'), block_id: header.hash });
    if (result.block_hash !== header.hash || !Array.isArray(result.result)) {
      throw new Error('Reward query did not use the finalized snapshot');
    }
    return JSON.parse(Buffer.from(result.result).toString());
  }
  const [core, budget] = await Promise.all([
    view(contract, 'get_reward_config'), view(copper, 'get_reward_budget'),
  ]);
  if (core?.receipt_signer !== config.receiptSigner || core?.ruleset !== config.ruleset ||
      core?.copper_id !== copper || budget?.epoch_length_ns !== config.epochLengthNs ||
      !atomic(budget?.epoch) || !atomic(budget.epoch_length_ns) || budget.epoch_length_ns === '0' ||
      BigInt(budget.epoch) !== BigInt(header.timestamp_nanosec) / BigInt(budget.epoch_length_ns)) {
    throw new Error('Finalized reward deployment mismatch');
  }
  return {
    contract, ruleset: core.ruleset, epoch: budget.epoch, hash: header.hash, timestampNs: header.timestamp_nanosec,
    readClaim: receipt => view(contract, 'get_operation', {
      operation_id: receipt.claim_id, account_id: receipt.account_id, kind: 'reward',
    }),
  };
}

export async function reconcileRewardReservation(file, { runId, snapshot, apply = false }) {
  const db = new DatabaseSync(file, { readOnly: !apply });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const program = JSON.stringify(['testnet', snapshot.contract, snapshot.ruleset]);
    function readLocal() {
      const reservation = db.prepare(`SELECT r.*, a.released, a.finalized_epoch
        FROM run_reward_reservations r LEFT JOIN run_reward_releases a USING (run_id) WHERE r.run_id = ?`).get(runId);
      const claims = db.prepare('SELECT region, payload FROM run_reward_claims WHERE run_id = ? ORDER BY region').all(runId);
      return { reservation, claims };
    }
    const local = readLocal();
    if (!local.reservation) throw new Error('Reward reservation missing');
    const { domain, beneficiary, maximum, released, finalized_epoch } = local.reservation;
    const [storedProgram, epoch] = JSON.parse(domain);
    if (storedProgram !== program || !atomic(epoch)) throw new Error('Reward reservation domain mismatch');
    if (!atomic(finalized_epoch) || BigInt(finalized_epoch) <= BigInt(epoch) ||
        BigInt(snapshot.epoch) < BigInt(finalized_epoch)) {
      throw new Error('Run must already have an audited unsigned release from a finalized epoch rollover');
    }
    const signed = local.claims.map(({ region, payload }) => {
      const { receipt } = JSON.parse(payload);
      const claimId = createHash('sha256').update(JSON.stringify([domain, runId, region])).digest('hex');
      if (!Number.isInteger(region) || region < 1 || region > 5 ||
          receipt?.network !== 'testnet' || receipt.contract !== snapshot.contract ||
          receipt.ruleset !== snapshot.ruleset || receipt.run_id !== runId || receipt.account_id !== beneficiary ||
          receipt.epoch !== epoch || receipt.claim_id !== claimId || !atomic(receipt.amount) ||
          receipt.amount === '0' || !atomic(receipt.expires_at_ns)) throw new Error('Stored claim binding mismatch');
      return receipt;
    });
    if (!atomic(maximum) || !atomic(released) ||
        BigInt(released) + signed.reduce((total, receipt) => total + BigInt(receipt.amount), 0n) !== BigInt(maximum)) {
      throw new Error('Reward reservation balance mismatch');
    }
    const observed = [];
    for (const receipt of signed) {
      const operation = await snapshot.readClaim(receipt);
      if (operation !== null && (!operation || operation.amount !== receipt.amount ||
          Object.keys(operation.receipt ?? {}).length !== Object.keys(receipt).length ||
          Object.entries(receipt).some(([key, value]) => operation.receipt?.[key] !== value) ||
          !['pending', 'settled', 'expired'].includes(operation.status))) {
        throw new Error('Finalized checkpoint operation mismatch');
      }
      const status = operation === null ? 'absent' : operation.status;
      const eligible = status === 'expired' ||
        (status === 'absent' && BigInt(snapshot.timestampNs) > BigInt(receipt.expires_at_ns));
      observed.push({ claimId: receipt.claim_id, amountAtomic: receipt.amount, status, eligible });
    }
    const result = {
      runId, program, epoch, finalizedBlockHash: snapshot.hash, finalizedTimestampNs: snapshot.timestampNs,
      finalizedEpoch: snapshot.epoch, claims: observed, mode: apply ? 'apply' : 'preview', releasedAtomic: '0',
    };
    const auditExists = () => db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'run_reward_claim_releases'").get();
    function pendingReleases() {
      const previous = auditExists() ? db.prepare('SELECT * FROM run_reward_claim_releases WHERE run_id = ?').all(runId) : [];
      for (const row of previous) {
        const claim = observed.find(item => item.claimId === row.claim_id);
        if (!claim?.eligible || claim.amountAtomic !== row.released) throw new Error('Prior claim release conflicts with finalized evidence');
        claim.alreadyReleased = true;
      }
      return observed.filter(claim => claim.eligible && !claim.alreadyReleased);
    }
    const totalFor = claims => claims.reduce((total, claim) => total + BigInt(claim.amountAtomic), 0n);
    if (!apply) return { ...result, releasableAtomic: String(totalFor(pendingReleases())) };
    db.exec('BEGIN IMMEDIATE');
    try {
      if (JSON.stringify(readLocal()) !== JSON.stringify(local)) throw new Error('Reward reservation changed during reconciliation');
      const pending = pendingReleases();
      const total = totalFor(pending);
      if (total > 0n) {
        db.exec(`CREATE TABLE IF NOT EXISTS run_reward_claim_releases (
          claim_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, released TEXT NOT NULL, status TEXT NOT NULL,
          finalized_block TEXT NOT NULL, finalized_timestamp_ns TEXT NOT NULL, finalized_epoch TEXT NOT NULL
        )`);
        const balance = db.prepare('SELECT reserved FROM run_reward_programs WHERE program = ?').get(program);
        if (!atomic(balance?.reserved) || BigInt(balance.reserved) < total) throw new Error('Reward program balance mismatch');
        const insert = db.prepare('INSERT INTO run_reward_claim_releases VALUES (?, ?, ?, ?, ?, ?, ?)');
        for (const claim of pending) {
          insert.run(claim.claimId, runId, claim.amountAtomic, claim.status, snapshot.hash, snapshot.timestampNs, snapshot.epoch);
        }
        db.prepare('UPDATE run_reward_programs SET reserved = ? WHERE program = ?')
          .run(String(BigInt(balance.reserved) - total), program);
      }
      db.exec('COMMIT');
      return { ...result, releasableAtomic: String(total), releasedAtomic: String(total) };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}
