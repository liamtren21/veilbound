const routes = [
  [/^\/health$/, 'health'],
  [/^\/api\/(guest|logout)$/, 'session'],
  [/^\/api\/auth\//, 'auth'],
  [/^\/api\/starter(?:\/|$)/, 'starter'],
  [/^\/api\/runs\/[^/]+\/actions$/, 'run_action'],
  [/^\/api\/runs\/[^/]+\/prepare-bank$/, 'bank'],
  [/^\/api\/runs(?:\/|$)/, 'runs'],
  [/^\/api\/field-contracts(?:\/|$)/, 'field'],
  [/^\/api\/modes(?:\/|$)/, 'modes'],
  [/^\/api\/(economy|shop|market|professions|chronicle)(?:\/|$)/, 'economy'],
];
const operations = new Set(['field_recovery', 'starter_provision', 'reward_reconciliation', 'npc_job', 'websocket']);
const outcomes = new Set(['success', 'pending', 'rejected', 'error']);
const methods = new Set(['GET', 'POST', 'HEAD', 'OPTIONS']);

export function createObservability({
  enabled = false, sink = line => console.log(line), now = () => performance.now(),
} = {}) {
  if (!enabled) return undefined;
  const emit = event => {
    try { sink(JSON.stringify(event)); } catch {}
  };
  return {
    observeRequest(request, response) {
      const path = (request.url ?? '').split('?', 1)[0];
      const route = routes.find(([pattern]) => pattern.test(path))?.[1] ?? 'other';
      if (route === 'health') return;
      const method = methods.has(request.method) ? request.method : 'OTHER';
      const started = now();
      let recorded = false;
      const record = completed => {
        if (recorded) return;
        recorded = true;
        const status = response.statusCode;
        emit({ event: 'http_request', route, method, status: completed && Number.isInteger(status) ? status : null,
          outcome: completed ? 'completed' : 'aborted', durationMs: Math.max(0, Math.round(now() - started)) });
      };
      response.once('finish', () => record(true));
      response.once('close', () => record(false));
    },
    recordOperation(operation, outcome) {
      if (!operations.has(operation) || !outcomes.has(outcome)) return;
      emit({ event: 'operation', operation, outcome });
    },
  };
}
