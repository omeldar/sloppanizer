import type Database from "better-sqlite3";
import { EXPORT_TABLES } from "./export.ts";

/** Settings of this device: never exported, and kept when a restore replaces the data. */
export const LOCAL_SETTING_KEYS = ["lastFolderExport", "restoreInProgress"] as const;

/** Tables with AUTOINCREMENT ids that appear in Markdown (#123, attachment links). */
export const SEQUENCE_TABLES = ["todos", "attachments"] as const;

export type ExportData = Record<string, Record<string, unknown>[]>;
export type Sequences = Partial<Record<(typeof SEQUENCE_TABLES)[number], number>>;

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Column names of a table in the current schema. */
export function tableColumns(sqlite: Database.Database, table: string): Set<string> {
  const rows = sqlite.prepare(`PRAGMA table_info(${quote(table)})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/** A row that cannot be inserted, with its table and id for the problem list. */
export class RowError extends Error {
  readonly table: string;
  readonly rowId: unknown;

  constructor(table: string, rowId: unknown, message: string) {
    super(`${table}${rowId === undefined ? "" : ` ${String(rowId)}`}: ${message}`);
    this.table = table;
    this.rowId = rowId;
  }
}

/**
 * Replaces every export table with the rows of an export, inside the caller's transaction:
 * deletes in reverse order (settings except the local keys), inserts every row with its original
 * id (local settings in the file are skipped), and sets the todo and attachment sequences to the
 * higher of the exported sequence and the largest id, so ids are never handed out again. Foreign
 * keys are checked at commit (defer_foreign_keys), because a todo may point at a parent with a
 * higher id. Columns missing in old formats get their defaults.
 */
export function replaceAllData(sqlite: Database.Database, data: ExportData, sequences: Sequences = {}): void {
  if (!sqlite.inTransaction) throw new Error("replaceAllData needs a transaction");
  sqlite.pragma("defer_foreign_keys = ON");
  const local = LOCAL_SETTING_KEYS.map(() => "?").join(", ");
  for (const table of EXPORT_TABLES.toReversed()) {
    if (table === "settings")
      sqlite.prepare(`DELETE FROM settings WHERE key NOT IN (${local})`).run(...LOCAL_SETTING_KEYS);
    else sqlite.prepare(`DELETE FROM ${quote(table)}`).run();
  }
  for (const table of EXPORT_TABLES) {
    const columns = tableColumns(sqlite, table);
    const statements = new Map<string, Database.Statement>();
    for (const row of data[table] ?? []) {
      if (table === "settings" && (LOCAL_SETTING_KEYS as readonly unknown[]).includes(row.key)) continue;
      const names = Object.keys(row);
      const unknown = names.filter((name) => !columns.has(name));
      if (unknown.length > 0) throw new RowError(table, row.id, `unknown column ${unknown.join(", ")}`);
      const key = names.join("\u0000");
      let statement = statements.get(key);
      if (!statement) {
        statement = sqlite.prepare(
          `INSERT INTO ${quote(table)} (${names.map(quote).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
        );
        statements.set(key, statement);
      }
      try {
        statement.run(...names.map((name) => row[name]));
      } catch (error) {
        throw new RowError(table, row.id ?? row.key, (error as Error).message);
      }
    }
  }
  for (const table of SEQUENCE_TABLES) {
    const { maxId } = sqlite.prepare(`SELECT coalesce(max(id), 0) AS maxId FROM ${quote(table)}`).get() as {
      maxId: number;
    };
    const seq = Math.max(sequences[table] ?? 0, maxId);
    sqlite.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(table);
    if (seq > 0) sqlite.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(table, seq);
  }
}
