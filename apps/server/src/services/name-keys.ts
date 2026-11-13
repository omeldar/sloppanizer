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
 * Fills missing or outdated name keys and merges rows of one account whose names differ only in case
 * (names of two accounts never meet): the oldest row
 * (lowest id) keeps its name and color and takes over the links of the others (a person or todo linked
 * to both keeps one link), then the others are deleted. Runs for every account at start and for one
 * account (`accountId`) after its restore, inside the caller's transaction if there is one.
 * The search index is not touched: the callers rebuild it right after. Returns the number of merged rows.
 */
export function repairNameKeys(sqlite: Database.Database, accountId?: number): number {
  const only = accountId === undefined ? "" : `WHERE account_id = ${Number(accountId)}`;
  let merged = 0;
  const run = sqlite.transaction(() => {
    for (const { table, links } of KEYED_TABLES) {
      const rows = sqlite
        .prepare(`SELECT account_id, id, name, name_key FROM ${table} ${only} ORDER BY account_id, id`)
        .all() as {
        account_id: number;
        id: number;
        name: string;
        name_key: string | null;
      }[];
      const keepers = new Map<string, number>();
      const stale: { accountId: number; id: number; key: string }[] = [];
      const moveLinks = sqlite.prepare(
        `UPDATE OR IGNORE ${links.table} SET ${links.column} = ? WHERE account_id = ? AND ${links.column} = ?`,
      );
      const remove = sqlite.prepare(`DELETE FROM ${table} WHERE account_id = ? AND id = ?`);
      for (const row of rows) {
        const key = foldCase(row.name);
        const keeperKey = `${row.account_id}\u0000${key}`;
        const keeper = keepers.get(keeperKey);
        if (keeper === undefined) {
          keepers.set(keeperKey, row.id);
          if (row.name_key !== key) stale.push({ accountId: row.account_id, id: row.id, key });
          continue;
        }
        // Links that already exist on the keeper stay behind and go with the row (ON DELETE CASCADE).
        moveLinks.run(keeper, row.account_id, row.id);
        remove.run(row.account_id, row.id);
        merged += 1;
      }
      // Clear first, so a key that moves from one row to another never clashes on the way.
      const clear = sqlite.prepare(`UPDATE ${table} SET name_key = NULL WHERE account_id = ? AND id = ?`);
      const set = sqlite.prepare(`UPDATE ${table} SET name_key = ? WHERE account_id = ? AND id = ?`);
      for (const { accountId: a, id } of stale) clear.run(a, id);
      for (const { accountId: a, id, key } of stale) set.run(key, a, id);
    }
  });
  run();
  return merged;
}
