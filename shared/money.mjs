const scale = 100n;
const maxAmount = (1n << 128n) - 1n;

export function parseCopper(value) {
  if (typeof value !== 'string' || !/^\d{1,39}(?:\.\d{1,2})?$/.test(value)) {
    throw new TypeError('Expected a Copper decimal string with at most two decimal places');
  }
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * scale + BigInt(fraction.padEnd(2, '0'));
  if (amount > maxAmount) throw new RangeError('Copper amount exceeds the contract range');
  return amount;
}

export function formatCopper(amount) {
  if (typeof amount !== 'bigint' || amount < 0n || amount > maxAmount) {
    throw new RangeError('Expected Copper atomic units in the contract range');
  }
  return `${amount / scale}.${String(amount % scale).padStart(2, '0')}`;
}
