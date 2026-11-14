const smooth = t => {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
};

// The same envelope supports both a single contact and a whole combo.
export function focusAmount(age, firstHit, lastHit = firstHit) {
  return smooth((age - (firstHit - .18)) / .18) *
    (1 - smooth((age - (lastHit + .08)) / .30));
}
