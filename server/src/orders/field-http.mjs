const run = /^[\w-]{1,96}$/;
const codeFor = {
  contract_missing: 404, contract_expired: 410, contract_unavailable: 409, contract_ineligible: 409,
  contract_unreachable: 409, objective_incomplete: 409, contract_active_limit: 409,
  contract_funder_unavailable: 503, field_beneficiary_unverified: 409, contract_settlement_pending: 409,
  field_reservation_state_conflict: 409, field_reservation_expired_without_funding: 410, field_payment_expired: 410, contract_not_cancellable: 409,
};
const failure = (status, code) => Object.assign(new Error(code), { status, code: code.toUpperCase() });

export function createFieldRoutes(field) {
  const route = async function ({ method, path, accountId, readBody }) {
    if (method === 'GET' && path === '/api/field-contracts') return { enabled: Boolean(field), offers: field?.offers() ?? [] };
    const runDetail = /^\/api\/field-contracts\/run\/([\w-]{1,96})$/.exec(path);
    if (method === 'GET' && runDetail) return field ? field.forRun(accountId, runDetail[1]) : { enabled: false, offers: [], contracts: [] };
    const accept = method === 'POST' && path === '/api/field-contracts/accept';
    const detail = /^\/api\/field-contracts\/([a-f0-9]{64})(?:\/(deliver|recover|cancel))?$/.exec(path);
    if (!accept && !detail) return undefined;
    const action = detail?.[2];
    if (!accept && (action ? method !== 'POST' : method !== 'GET')) return undefined;
    if (!field) throw failure(503, 'contract_funder_unavailable');
    try {
      if (accept) {
        const body = await readBody();
        if (Object.keys(body).length !== 2 || typeof body.runId !== 'string' || !run.test(body.runId) ||
            typeof body.offerId !== 'string' || !run.test(body.offerId)) throw failure(400, 'invalid_field_request');
        return await field.accept(accountId, body);
      }
      if (action && Object.keys(await readBody()).length) throw failure(400, 'invalid_field_request');
      return await field[action ?? 'get'](accountId, detail[1]);
    } catch (error) {
      if (error.status) throw error;
      const status = codeFor[error.message];
      if (status) throw failure(status, error.message);
      throw error;
    }
  };
  if (field) route.settleCompleted = (accountId, runId) => field.settleCompleted(accountId, runId);
  return route;
}


