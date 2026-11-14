import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCopper, formatCopper } from '../../shared/money.mjs';

test('Copper conversion preserves integer amounts and rejects invalid input', () => {
  assert.equal(parseCopper('0.01'), 1n);
  assert.equal(parseCopper('100.00'), 10000n);
  assert.equal(formatCopper(10001n), '100.01');
  for (const value of ['-1', '1e2', '0.001', ' 1', 1, '340282366920938463463374607431768211456']) {
    assert.throws(() => parseCopper(value));
  }
});
