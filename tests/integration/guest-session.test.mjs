import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openGuestSessions } from '../../server/src/auth/guest.mjs';

test('guest session resumes the same player and can be revoked', () => {
  let now = 1000;
  const sessions = openGuestSessions(':memory:', { clock: () => now, ttlMs: 100 });
  try {
    const first = sessions.create();
    assert.notEqual(first.token, first.playerId);
    assert.equal(sessions.read(first.token), first.playerId);
    assert.equal(sessions.read(first.playerId), null);
    const second = sessions.create();
    assert.notEqual(first.playerId, second.playerId);
    sessions.revoke(first.token);
    assert.equal(sessions.read(first.token), null);
    now += 100;
    assert.equal(sessions.read(second.token), null);
  } finally {
    sessions.close();
  }
});
