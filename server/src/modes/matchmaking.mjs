export const rankedQueueLifetime = 180_000;

export function matchRanked(queue, ratings, accountId, region, now) {
  const prior = queue.find(entry => entry.accountId === accountId && entry.region === region && now - entry.joinedAt < rankedQueueLifetime);
  queue = queue.filter(entry => entry.accountId !== accountId && now - entry.joinedAt < rankedQueueLifetime);
  const rating = id => ratings[id] ?? 1000;
  const candidates = queue.filter(entry => {
    const wait = now - entry.joinedAt;
    return (entry.region === region || wait >= 60_000) &&
      Math.abs(rating(entry.accountId) - rating(accountId)) <= Math.min(500, 100 + Math.floor(wait / 1_000) * 5);
  }).sort((left, right) => left.joinedAt - right.joinedAt);
  if (candidates.length) {
    const [opponent] = candidates;
    return { queue: queue.filter(entry => entry !== opponent), opponent: opponent.accountId };
  }
  return { queue: [...queue, { accountId, region, joinedAt: prior?.joinedAt ?? now }], opponent: null };
}

