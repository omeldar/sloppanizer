import type Database from "better-sqlite3";
import { ID_TABLES } from "../db/schema.ts";
import { authorKindOf } from "./comments.ts";
import { dbTable, EXPORT_TABLES, withoutLocalColumns } from "./export.ts";
import { limitProblem, rowProblem } from "./restore-checks.ts";
import { LOCAL_SETTING_KEYS, OBSOLETE_SETTING_KEYS } from "./settings.ts";

export type ExportData = Record<string, Record<string, unknown>[]>;
/**
 * Highest id ever given per id table (manifest.sequences). Single-user exports (format 3) name only
 * todos and attachments, format 4 every id table; a table without an entry counts from its largest id.
 */
export type Sequences = Partial<Record<string, number>>;

/** Settings keys a restore never takes from a file. */
const SKIPPED_SETTING_KEYS: ReadonlySet<unknown> = new Set([...LOCAL_SETTING_KEYS, ...OBSOLETE_SETTING_KEYS]);

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Columns that older exports lack and whose value follows from other columns of the row. */
const DERIVED_COLUMNS: Record<string, Record<string, (row: Record<string, unknown>) => unknown>> = {
  comments: { author_kind: (row) => authorKindOf(row.actor) },
};

/** The row as it is inserted: local columns dropped, derived columns filled when the file lacks them. */
function insertValues(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const values = { ...withoutLocalColumns(table, row) };
  for (const [column, derive] of Object.entries(DERIVED_COLUMNS[table] ?? {})) {
    if (!(column in values)) values[column] = derive(row);
  }
  return values;
}

/**
 * Column names a data.json table may have: the columns of its database table in the current schema,
 * without account_id (the restore stamps it).
 */
export function tableColumns(sqlite: Database.Database, table: string): Set<string> {
  const rows = sqlite.prepare(`PRAGMA table_info(${quote(dbTable(table))})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name).filter((name) => name !== "account_id"));
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
 * Replaces one account's data with the rows of an export, inside the caller's transaction. Other
 * accounts are not touched: every delete and insert carries the account id. Deletes in reverse order
 * (settings except the local keys), inserts every row with account_id stamped and its original id
 * (local and obsolete settings in the file are skipped), and sets every id table's sequence of the
 * account to the higher of the exported sequence and the largest id, so ids are never handed out
 * again. Foreign keys are checked at commit (defer_foreign_keys), because a todo may point at a parent
 * with a higher id. Columns missing in old formats get their defaults (or DERIVED_COLUMNS); local
 * columns (LOCAL_COLUMNS) in the file are skipped, the caller refills them (repairNameKeys,
 * linkCommentAuthors). Meeting rows are checked first (restore-checks.ts): limits and the shape of their JSON,
 * dates and times.
 */
export function replaceAccountData(
  sqlite: Database.Database,
  accountId: number,
  data: ExportData,
  sequences: Sequences = {},
): void {
  if (!sqlite.inTransaction) throw new Error("replaceAccountData needs a transaction");
  const overLimit = limitProblem(data);
  if (overLimit !== null) throw new RowError(overLimit.table, undefined, overLimit.message);
  sqlite.pragma("defer_foreign_keys = ON");
  const local = LOCAL_SETTING_KEYS.map(() => "?").join(", ");
  for (const table of EXPORT_TABLES.toReversed()) {
    if (table === "settings")
      sqlite
        .prepare(`DELETE FROM account_settings WHERE account_id = ? AND key NOT IN (${local})`)
        .run(accountId, ...LOCAL_SETTING_KEYS);
    else sqlite.prepare(`DELETE FROM ${quote(table)} WHERE account_id = ?`).run(accountId);
  }
  for (const table of EXPORT_TABLES) {
    const columns = tableColumns(sqlite, table);
    const statements = new Map<string, Database.Statement>();
    for (const row of data[table] ?? []) {
      if (table === "settings" && SKIPPED_SETTING_KEYS.has(row.key)) continue;
      const unknown = Object.keys(row).filter((name) => !columns.has(name));
      if (unknown.length > 0) throw new RowError(table, row.id, `unknown column ${unknown.join(", ")}`);
      const problem = rowProblem(table, row);
      if (problem !== null) throw new RowError(table, row.id ?? row.occurs_on, problem);
      const values: Record<string, unknown> = { ...insertValues(table, row), account_id: accountId };
      const names = Object.keys(values);
      const key = names.join("\u0000");
      let statement = statements.get(key);
      if (!statement) {
        statement = sqlite.prepare(
          `INSERT INTO ${quote(dbTable(table))} (${names.map(quote).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
        );
        statements.set(key, statement);
      }
      try {
        statement.run(...names.map((name) => values[name]));
      } catch (error) {
        throw new RowError(table, row.id ?? row.key, (error as Error).message);
      }
    }
  }
  sqlite.prepare("DELETE FROM account_sequences WHERE account_id = ?").run(accountId);
  const setSequence = sqlite.prepare(
    "INSERT INTO account_sequences (account_id, table_name, last_id) VALUES (?, ?, ?)",
  );
  for (const table of ID_TABLES) {
    const { maxId } = sqlite
      .prepare(`SELECT coalesce(max(id), 0) AS maxId FROM ${quote(table)} WHERE account_id = ?`)
      .get(accountId) as { maxId: number };
    const exported = sequences[table];
    const seq = Math.max(typeof exported === "number" && Number.isInteger(exported) ? exported : 0, maxId);
    if (seq > 0) setSequence.run(accountId, table, seq);
  }
}
