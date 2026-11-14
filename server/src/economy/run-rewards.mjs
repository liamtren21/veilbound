import { createHash, createPrivateKey, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }); };
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,95}$/.test(value);
const amount = value => typeof value === 'string' && /^(0|[1-9]\d{0,38})$/.test(value) &&
  BigInt(value) <= (1n << 128n) - 1n;
const account = value => typeof value === 'string' && value.length <= 64 &&
  /^(?:[a-z0-9]+(?:[-_.][a-z0-9]+)*\.testnet|[a-f0-9]{64})$/.test(value);
const fields = ['network', 'contract', 'ruleset', 'account_id', 'run_id', 'encounter_id',
  'sequence', 'claim_id', 'amount', 'epoch', 'expires_at_ns'];

export function rewardMessage(receipt) {
  return Buffer.from(['VEILBOUND_REWARD_V1', ...fields.map(field => receipt[field])].join('\n'));
}

export function openRunRewards(file, {
  privateKey, contractId, ruleset, epoch, epochEndsAtMs, runBudgetAtomic, totalBudgetAtomic,
  beneficiaryForPlayer, epochBudgetAtomic = totalBudgetAtomic, now = Date.now, readFinalClaim, finalizedEpoch,
  checkpointShares,
} = {}) {
  if (!account(contractId) || !id(ruleset) || !amount(epoch) || BigInt(epoch) > (1n << 64n) - 1n ||
    !Number.isSafeInteger(epochEndsAtMs) || !amount(runBudgetAtomic) || !amount(totalBudgetAtomic) ||
    BigInt(runBudgetAtomic) === 0n || !amount(epochBudgetAtomic) ||
    BigInt(runBudgetAtomic) > BigInt(epochBudgetAtomic) || BigInt(epochBudgetAtomic) > BigInt(totalBudgetAtomic) ||
    typeof beneficiaryForPlayer !== 'function') throw new Error('Invalid reward configuration');
  const key = privateKey?.type === 'private' ? privateKey : createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Expected Ed25519 reward signer');
  if (checkpointShares !== undefined && (!Array.isArray(checkpointShares) || checkpointShares.length !== 5 ||
      checkpointShares.some(share => !Number.isSafeInteger(share) || share <= 0) ||
      checkpointShares.reduce((sum, share) => sum + share, 0) !== 10000)) throw new Error('Invalid checkpoint reward shares');
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS run_reward_programs (program TEXT PRIMARY KEY, maximum TEXT NOT NULL, reserved TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS run_reward_budgets (domain TEXT PRIMARY KEY, maximum TEXT NOT NULL, reserved TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS run_reward_reservations (
      run_id TEXT PRIMARY KEY, player TEXT NOT NULL, beneficiary TEXT NOT NULL, domain TEXT NOT NULL, maximum TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS run_reward_claims (
      run_id TEXT NOT NULL, region INTEGER NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(run_id, region)
    );
    CREATE TABLE IF NOT EXISTS run_reward_releases (
      run_id TEXT PRIMARY KEY, released TEXT NOT NULL, finalized_epoch TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS run_reward_schedules (
      run_id TEXT PRIMARY KEY, shares TEXT NOT NULL
    );
  `);
  const program = JSON.stringify(['testnet', contractId, ruleset]);
  const domain = JSON.stringify([program, epoch]);
  function transact(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  transact(() => {
    const global = db.prepare('SELECT maximum FROM run_reward_programs WHERE program = ?').get(program);
    if (global && global.maximum !== totalBudgetAtomic) throw new Error('Reward budget configuration changed');
    if (!global) db.prepare('INSERT INTO run_reward_programs VALUES (?, ?, ?)').run(program, totalBudgetAtomic, '0');
    const prior = db.prepare('SELECT maximum FROM run_reward_budgets WHERE domain = ?').get(domain);
    if (prior && prior.maximum !== epochBudgetAtomic) throw new Error('Reward budget configuration changed');
    if (!prior) db.prepare('INSERT INTO run_reward_budgets VALUES (?, ?, ?)').run(domain, epochBudgetAtomic, '0');
    // Once the chain has entered a later epoch, no additional claims can be issued for
    // the old reservation. Keep every signed amount reserved, even if its outcome is unknown.
    if (finalizedEpoch !== undefined) {
      if (finalizedEpoch !== epoch) throw new Error('Unexpected finalized reward epoch');
      const old = db.prepare(`SELECT r.* FROM run_reward_reservations r
        JOIN run_reward_budgets b ON b.domain = r.domain
        LEFT JOIN run_reward_releases a ON a.run_id = r.run_id
        WHERE a.run_id IS NULL AND json_extract(b.domain, '$[0]') = ? AND r.domain != ?`).all(program, domain);
      const claims = db.prepare('SELECT payload FROM run_reward_claims WHERE run_id = ?');
      let released = 0n;
      for (const row of old) {
        const [, previousEpoch] = JSON.parse(row.domain);
        if (BigInt(previousEpoch) >= BigInt(finalizedEpoch)) continue;
        const issued = claims.all(row.run_id).reduce((sum, claim) => sum + BigInt(JSON.parse(claim.payload).receipt.amount), 0n);
        const unused = BigInt(row.maximum) - issued;
        if (unused < 0n) throw new Error('Reward reservation is inconsistent');
        db.prepare('INSERT INTO run_reward_releases VALUES (?, ?, ?)').run(row.run_id, String(unused), finalizedEpoch);
        released += unused;
      }
      if (released) {
        const balance = db.prepare('SELECT reserved FROM run_reward_programs WHERE program = ?').get(program);
        const remaining = BigInt(balance.reserved) - released;
        if (remaining < 0n) throw new Error('Reward program balance is inconsistent');
        db.prepare('UPDATE run_reward_programs SET reserved = ? WHERE program = ?').run(String(remaining), program);
      }
    }
  });
  const reservation = runId => db.prepare('SELECT * FROM run_reward_reservations WHERE run_id = ?').get(runId);
  return {
    async reconcile(payload) {
      if (!readFinalClaim) return payload;
      const { receipt } = payload;
      const operation = await readFinalClaim(receipt);
      if (!operation) {
        if (BigInt(now()) * 1000000n < BigInt(receipt.expires_at_ns)) return payload;
        return { status: 'expired', receipt };
      }
      if (operation.amount !== receipt.amount || fields.some(field => operation.receipt?.[field] !== receipt[field]) ||
          !['pending', 'settled', 'expired', 'refunded'].includes(operation.status)) {
        fail('REWARD_SETTLEMENT_MISMATCH', 409);
      }
      if (operation.status !== 'pending') return { status: operation.status, receipt };
      const transaction = {
        ...payload.transaction, actions: [{ type: 'FunctionCall', params: {
          methodName: 'retry_settlement', args: { operation_id: receipt.claim_id, kind: 'reward' },
          gas: '150000000000000', deposit: '0',
        } }],
      };
      return { status: 'pending', receipt, transaction };
    },
    reserve(player, runId) {
      if (!id(runId)) fail('INVALID_RUN', 400);
      if (now() >= epochEndsAtMs) fail('REWARD_EPOCH_CLOSED');
      const beneficiary = beneficiaryForPlayer(player);
      if (!account(beneficiary)) fail('WALLET_REQUIRED');
      return transact(() => {
        const prior = reservation(runId);
        if (prior) {
          if (prior.player !== player || prior.beneficiary !== beneficiary || prior.domain !== domain) fail('REWARD_RESERVATION_CONFLICT');
          return { beneficiary, maximumAtomic: prior.maximum, epoch, expiresAtMs: epochEndsAtMs };
        }
        const budget = db.prepare('SELECT * FROM run_reward_budgets WHERE domain = ?').get(domain);
        const next = BigInt(budget.reserved) + BigInt(runBudgetAtomic);
        const global = db.prepare('SELECT * FROM run_reward_programs WHERE program = ?').get(program);
        const globalNext = BigInt(global.reserved) + BigInt(runBudgetAtomic);
        if (next > BigInt(budget.maximum) || globalNext > BigInt(global.maximum)) fail('REWARD_BUDGET_EXHAUSTED');
        db.prepare('UPDATE run_reward_programs SET reserved = ? WHERE program = ?').run(String(globalNext), program);
        db.prepare('UPDATE run_reward_budgets SET reserved = ? WHERE domain = ?').run(String(next), domain);
        db.prepare('INSERT INTO run_reward_reservations VALUES (?, ?, ?, ?, ?)').run(runId, player, beneficiary, domain, runBudgetAtomic);
        if (checkpointShares) db.prepare('INSERT INTO run_reward_schedules VALUES (?, ?)').run(runId, JSON.stringify(checkpointShares));
        return { beneficiary, maximumAtomic: runBudgetAtomic, epoch, expiresAtMs: epochEndsAtMs };
      });
    },
    prepare(player, evidence, region) {
      if (evidence?.mode !== 'expedition' || !Number.isSafeInteger(region) || region < 1 || region > 5 ||
        !Array.isArray(evidence.checkpoints) || !Array.isArray(evidence.checkpointSequences)) fail('INVALID_REWARD_EVIDENCE', 422);
      const record = reservation(evidence.runId);
      if (!record || record.player !== player) fail('REWARD_RESERVATION_MISSING');
      const position = evidence.checkpoints.findIndex(checkpoint => checkpoint.region === region);
      const checkpoint = evidence.checkpoints[position];
      if (!checkpoint || !id(checkpoint.node) || !amount(checkpoint.copperAtomic) ||
        !Number.isSafeInteger(evidence.checkpointSequences[position])) fail('BANK_NOT_READY');
      return transact(() => {
        const prior = db.prepare('SELECT payload FROM run_reward_claims WHERE run_id = ? AND region = ?').get(evidence.runId, region);
        if (prior) return JSON.parse(prior.payload);
        if (record.domain !== domain || now() >= epochEndsAtMs ||
            db.prepare('SELECT 1 FROM run_reward_releases WHERE run_id = ?').get(evidence.runId)) fail('REWARD_EPOCH_CLOSED');
        // Cumulative allocation makes payout independent of the order checkpoints are claimed.
        const schedule = db.prepare('SELECT shares FROM run_reward_schedules WHERE run_id = ?').get(evidence.runId);
        const shares = schedule ? JSON.parse(schedule.shares) : null;
        const maximum = BigInt(record.maximum);
        let allocated = 0n;
        let payable = 0n;
        for (const item of evidence.checkpoints.slice(0, position + 1)) {
          if (!amount(item.copperAtomic) || !Number.isInteger(item.region) || item.region < 1 || item.region > 5) {
            fail('INVALID_REWARD_EVIDENCE', 422);
          }
          const share = shares ? shares.slice(0, item.region).reduce((sum, value) => sum + value, 0) : 10000;
          const capacity = maximum * BigInt(share) / 10000n - allocated;
          const earned = BigInt(item.copperAtomic);
          payable = earned < capacity ? earned : capacity;
          allocated += payable;
        }
        if (!payable) fail('REWARD_CAP_REACHED');
        const claimId = createHash('sha256').update(JSON.stringify([domain, evidence.runId, region])).digest('hex');
        const receipt = {
          network: 'testnet', contract: contractId, ruleset, account_id: record.beneficiary,
          run_id: evidence.runId, encounter_id: checkpoint.node,
          sequence: String(evidence.checkpointSequences[position]), claim_id: claimId,
          amount: String(payable), epoch, expires_at_ns: String(BigInt(epochEndsAtMs) * 1000000n),
        };
        const signature = sign(null, rewardMessage(receipt), key).toString('base64');
        const payload = {
          status: 'prepared', receipt, signature, maximumAtomic: record.maximum,
          transaction: { network: 'testnet', receiverId: contractId, actions: [{
            type: 'FunctionCall', params: { methodName: 'claim_reward', args: { receipt, signature },
              gas: '150000000000000', deposit: '1' },
          }] },
        };
        db.prepare('INSERT INTO run_reward_claims VALUES (?, ?, ?)').run(evidence.runId, region, JSON.stringify(payload));
        return payload;
      });
    },
    close() { db.close(); },
  };
}

