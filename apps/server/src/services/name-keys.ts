import type Database from "better-sqlite3";
import { foldCase } from "./text.ts";

/**
 * Names that must be unique without case (labels, topics, person tags) carry name_key = foldCase(name),
 * unique in the database. SQLite's NOCASE and lower() fold ASCII only, so the key is computed here.
 */
interface KeyedTable {
  table: "labels" | "topics" | "person_tags";
  /** The link table and its column pointing at the named row; merged rows move their links here. */
  links: { table: string; column: string };
}

const KEYED_TABLES: readonly KeyedTable[] = [
  { table: "labels", links: { table: "todo_labels", column: "label_id" } },
  { table: "topics", links: { table: "person_topics", column: "topic_id" } },
  { table: "person_tags", links: { table: "person_tag_links", column: "tag_id" } },
];

/**
 * Fills missing or outdated name keys and merges rows whose names differ only in case: the oldest row
 * (lowest id) keeps its name and color and takes over the links of the others (a person or todo linked
 * to both keeps one link), then the others are deleted. Runs at every start (after migration 0006 the
 * keys of existing rows are empty) and after a restore, inside the caller's transaction if there is one.
 * The search index is not touched: the callers rebuild it right after. Returns the number of merged rows.
 */
export function repairNameKeys(sqlite: Database.Database): number {
  let merged = 0;
  const run = sqlite.transaction(() => {
    for (const { table, links } of KEYED_TABLES) {
      const rows = sqlite.prepare(`SELECT id, name, name_key FROM ${table} ORDER BY id`).all() as {
        id: number;
        name: string;
        name_key: string | null;
      }[];
      const keepers = new Map<string, number>();
      const stale: { id: number; key: string }[] = [];
      const moveLinks = sqlite.prepare(
        `UPDATE OR IGNORE ${links.table} SET ${links.column} = ? WHERE ${links.column} = ?`,
      );
      const remove = sqlite.prepare(`DELETE FROM ${table} WHERE id = ?`);
      for (const row of rows) {
        const key = foldCase(row.name);
        const keeper = keepers.get(key);
        if (keeper === undefined) {
          keepers.set(key, row.id);
          if (row.name_key !== key) stale.push({ id: row.id, key });
          continue;
        }
        // Links that already exist on the keeper stay behind and go with the row (ON DELETE CASCADE).
        moveLinks.run(keeper, row.id);
        remove.run(row.id);
        merged += 1;
      }
      // Clear first, so a key that moves from one row to another never clashes on the way.
      const clear = sqlite.prepare(`UPDATE ${table} SET name_key = NULL WHERE id = ?`);
      const set = sqlite.prepare(`UPDATE ${table} SET name_key = ? WHERE id = ?`);
      for (const { id } of stale) clear.run(id);
      for (const { id, key } of stale) set.run(key, id);
    }
  });
  run();
  return merged;
}
