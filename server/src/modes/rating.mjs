const initialRating = 1000;
const pairKey = players => JSON.stringify(players.map(player => player.id).sort());

export function settleRating(season, match) {
  if (match.phase !== 'finished' || !match.ranked || Object.hasOwn(season.receipts, match.id)) return;
  const [left, right] = match.players;
  const pair = pairKey(match.players);
  const previous = season.pairs[pair] ?? 0;
  season.pairs[pair] = previous + 1;
  const a = season.ratings[left.id] ?? initialRating;
  const b = season.ratings[right.id] ?? initialRating;
  const actual = match.winner === null ? 0.5 : Number(match.winner === left.id);
  const expected = 1 / (1 + 10 ** ((b - a) / 400));
  const delta = previous >= 3 ? 0 : Math.round(24 * (actual - expected));
  season.ratings[left.id] = a + delta;
  season.ratings[right.id] = b - delta;
  season.receipts[match.id] = { delta, repeatedPair: previous >= 3, forfeit: match.reason === 'timeout_forfeit' };
}

export const freshSeason = () => ({ ratings: {}, receipts: {}, pairs: {} });
