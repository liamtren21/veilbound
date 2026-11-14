import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createObservability } from '../../server/src/observability.mjs';

test('opt-in request metrics log fixed labels and exclude identifiers, request data and headers', () => {
  const events = [];
  let time = 1;
  assert.equal(createObservability(), undefined);
  const metrics = createObservability({ enabled: true, now: () => time, sink: line => events.push(JSON.parse(line)) });
  const response = new EventEmitter();
  response.statusCode = 409;
  metrics.observeRequest({
    method: 'POST', url: '/api/runs/secret-player-id/actions?token=secret-query',
    headers: { authorization: 'secret-token' }, body: 'secret-body',
  }, response);
  time = 10;
  response.emit('finish');
  response.emit('close');
  metrics.recordOperation('secret-operation', 'error');
  metrics.recordOperation('field_recovery', 'pending');
  assert.deepEqual(events, [
    { event: 'http_request', route: 'run_action', method: 'POST', status: 409, outcome: 'completed', durationMs: 9 },
    { event: 'operation', operation: 'field_recovery', outcome: 'pending' },
  ]);
});

test('an aborted request emits one record without a misleading HTTP status', () => {
  const events = [];
  const metrics = createObservability({ enabled: true, now: () => 1, sink: line => events.push(JSON.parse(line)) });
  const response = new EventEmitter();
  response.statusCode = 200;
  metrics.observeRequest({ method: 'GET', url: '/unknown/player-id' }, response);
  response.emit('close');
  assert.deepEqual(events[0], { event: 'http_request', route: 'other', method: 'GET', status: null, outcome: 'aborted', durationMs: 0 });
});
