import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { map, storyOpportunities } from '../../../expedition-data.mjs';

export function openJourneyShares(file, runs) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS journey_shares (
    id TEXT PRIMARY KEY, player TEXT NOT NULL, run TEXT NOT NULL, body TEXT NOT NULL,
    UNIQUE(player, run)
  )`);
  const insert = db.prepare('INSERT INTO journey_shares VALUES (?, ?, ?, ?) ON CONFLICT(player, run) DO UPDATE SET body = excluded.body');
  const byRun = db.prepare('SELECT id FROM journey_shares WHERE player = ? AND run = ?');
  const byId = db.prepare('SELECT player, run, body FROM journey_shares WHERE id = ?');
  return {
    async publish(player, runId) {
      const proof = await runs.journeyProof(player, runId);
      const body = {
        version: 2,
        outcome: proof.outcome,
        talisman: proof.state.talisman,
        digest: proof.stateHash,
        frames: proof.frames,
        highlights: proof.observations.filter(({ kind }) => kind === 'checkpoint')
          .map(({ sequence, node }) => ({ sequence, name: map[node].name })),
        decisions: (proof.state.storyMilestones ?? []).map(({ node }) => ({
          location: map[node].name, choice: storyOpportunities[node].label,
        })),
      };
      insert.run(randomUUID(), player, runId, JSON.stringify(body));
      return { path: '/journey-share.html?id=' + byRun.get(player, runId).id };
    },
    read(id) {
      const row = byId.get(id);
      return row ? JSON.parse(row.body) : null;
    },
    challenge(player, id) {
      const row = byId.get(id);
      return row ? runs.startJourneyChallenge(player, row.player, row.run, id) : null;
    },
    close() { db.close(); },
  };
}
