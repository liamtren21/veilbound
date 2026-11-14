import { DatabaseSync } from 'node:sqlite';
import { recipeFor } from '../../../shared/crafting.mjs';

const quests = Object.freeze({
  apothecary: { title: 'Juniper’s Field Medicine', objective: 'Restore health to a warden with a Reed Salve outside battle.',
    checkpoint: 1, bit: 1, matches: event => event.kind === 'salve-heal' },
  relicsmith: { title: 'Proof at the Kiln', objective: 'Defeat the elite at the Bailiff’s Vent in Ember Terraces.',
    checkpoint: 3, bit: 2, matches: event => event.kind === 'encounter-clear' && event.node === 'terraces-elite' },
  binder: { title: 'Names Beneath the Veil', objective: 'Speak the names aloud at the Hollow Orchard memorial.',
    checkpoint: 5, bit: 4, matches: event => event.kind === 'remember-names' && event.node === 'memorial' },
});

export function openProfessions(file, { runs }) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS professions (
      player TEXT PRIMARY KEY, region INTEGER NOT NULL, specialty TEXT
    );`);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('PRAGMA table_info(professions)').all().some(column => column.name === 'objectives')) {
      db.exec(`ALTER TABLE professions ADD COLUMN objectives INTEGER NOT NULL DEFAULT 0;
        UPDATE professions SET objectives = CASE WHEN region >= 5 THEN 7 WHEN region >= 3 THEN 3
          WHEN region >= 1 THEN 1 ELSE 0 END;`);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    db.close();
    throw error;
  }
  const find = db.prepare('SELECT region, specialty, objectives FROM professions WHERE player = ?');
  const advance = db.prepare(`INSERT INTO professions (player, region, objectives) VALUES (?, ?, ?)
    ON CONFLICT(player) DO UPDATE SET region = max(region, excluded.region),
      objectives = objectives | excluded.objectives`);
  const select = db.prepare('UPDATE professions SET specialty = ? WHERE player = ? AND region >= ? AND (objectives & ?) <> 0');
  function status(player) {
    const row = find.get(player);
    const region = row?.region ?? 0;
    const progress = Object.entries(quests).map(([specialty, quest]) => {
      const objectiveMet = Boolean((row?.objectives ?? 0) & quest.bit);
      return { specialty, title: quest.title, objective: quest.objective, checkpoint: quest.checkpoint,
        objectiveMet, completed: objectiveMet && region >= quest.checkpoint };
    });
    return { region, active: row?.specialty ?? null,
      unlocked: progress.filter(quest => quest.completed).map(quest => quest.specialty), quests: progress };
  }
  return {
    status,
    authorizeCraft(player, { recipeId, workshop }) {
      const recipe = recipeFor(recipeId, 1);
      if (workshop !== 'public' && (workshop !== 'specialty' || status(player).active !== recipe.specialty)) {
        throw new Error('PROFESSION_SPECIALTY_REQUIRED');
      }
      return recipe;
    },
    async record(player, runId) {
      const proof = await runs.verifyProgress(player, runId);
      if (proof.accountId !== player || proof.mode !== 'expedition') throw new Error('PROFESSION_EXPEDITION_REQUIRED');
      const cleared = new Set(proof.observations.filter(event => event.kind === 'checkpoint').map(event => event.node));
      const region = proof.checkpoints.reduce((highest, checkpoint) =>
        cleared.has(checkpoint.node) ? Math.max(highest, checkpoint.region) : highest, 0);
      const objectives = Object.values(quests).reduce((mask, quest) =>
        proof.observations.some(quest.matches) ? mask | quest.bit : mask, 0);
      if (!Number.isSafeInteger(region) || region < 0 || region > 5 || (!region && !objectives)) {
        throw new Error('PROFESSION_CHECKPOINT_REQUIRED');
      }
      advance.run(player, region, objectives);
      return status(player);
    },
    select(player, specialty) {
      if (!Object.hasOwn(quests, specialty) ||
          select.run(specialty, player, quests[specialty].checkpoint, quests[specialty].bit).changes !== 1) {
        throw new Error('PROFESSION_LOCKED');
      }
      return status(player);
    },
    close() { db.close(); },
  };
}
