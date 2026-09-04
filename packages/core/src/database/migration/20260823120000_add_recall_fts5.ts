import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260823120000_add_recall_fts5",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE VIRTUAL TABLE IF NOT EXISTS recall_fts USING fts5(text, content="recall_chunk", content_rowid="rowid", tokenize="unicode61 remove_diacritics 2")`)
      yield* tx.run(`INSERT INTO recall_fts(rowid, text) SELECT rowid, text FROM recall_chunk`)
      yield* tx.run(`CREATE TRIGGER IF NOT EXISTS recall_ai AFTER INSERT ON recall_chunk BEGIN INSERT INTO recall_fts(rowid, text) VALUES (new.rowid, new.text); END`)
      yield* tx.run(`CREATE TRIGGER IF NOT EXISTS recall_ad AFTER DELETE ON recall_chunk BEGIN DELETE FROM recall_fts WHERE rowid = old.rowid; END`)
      yield* tx.run(`CREATE TRIGGER IF NOT EXISTS recall_au AFTER UPDATE ON recall_chunk BEGIN DELETE FROM recall_fts WHERE rowid = old.rowid; INSERT INTO recall_fts(rowid, text) VALUES (new.rowid, new.text); END`)
    })
  },
  down(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP TRIGGER IF EXISTS recall_au`)
      yield* tx.run(`DROP TRIGGER IF EXISTS recall_ad`)
      yield* tx.run(`DROP TRIGGER IF EXISTS recall_ai`)
      yield* tx.run(`DROP TABLE IF EXISTS recall_fts`)
    })
  },
} satisfies DatabaseMigration.Migration
