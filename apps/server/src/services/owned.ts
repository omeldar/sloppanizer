import { and, eq, getTableName, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import {
  attachments,
  comments,
  events,
  type IdTable,
  labels,
  meetings,
  notes,
  people,
  personTags,
  projects,
  series,
  timeBlocks,
  todoLinks,
  todos,
  todoUrls,
  topics,
} from "../db/schema.ts";
import type { Scoped, Tx } from "./context.ts";
import { foldCase } from "./text.ts";

/**
 * Rows owned by an account. Every user table has account_id; ids are counted per account in
 * account_sequences and never reused (the counter only grows).
 */

/** `table.account_id = <the scope's account>`, plus any further conditions. */
export function owned(
  sc: Pick<Scoped, "accountId">,
  table: { accountId: SQLiteColumn },
  ...conditions: (SQL | undefined)[]
): SQL {
  return and(eq(table.accountId, sc.accountId), ...conditions) as SQL;
}

/**
 * Reserves `count` new ids of an id table for the account and returns the first one (the others follow
 * it). On first use the counter starts after the highest id already in the table. Call it inside the
 * write transaction of the insert.
 */
export function reserveIds(sc: Scoped, table: IdTable, count = 1): number {
  const row = sc.db.get<{ last_id: number }>(sql`
    INSERT INTO account_sequences (account_id, table_name, last_id)
    VALUES (${sc.accountId}, ${table},
      (SELECT coalesce(max(id), 0) FROM ${sql.identifier(table)} WHERE account_id = ${sc.accountId}) + ${count})
    ON CONFLICT (account_id, table_name) DO UPDATE SET last_id = last_id + ${count}
    RETURNING last_id`);
  return row.last_id - count + 1;
}

/** The next id of an id table for the account. */
export const nextId = (sc: Scoped, table: IdTable): number => reserveIds(sc, table);

type IdTableDef =
  | typeof projects
  | typeof labels
  | typeof people
  | typeof topics
  | typeof personTags
  | typeof todos
  | typeof todoLinks
  | typeof events
  | typeof comments
  | typeof notes
  | typeof attachments
  | typeof todoUrls
  | typeof timeBlocks
  | typeof meetings
  | typeof series;

/**
 * Inserts rows into an id table of the scope's account: stamps account_id and gives each row the next
 * id of the account. Returns the ids in row order. Every insert into an id table goes through here.
 */
export function insertOwned<T extends IdTableDef>(
  sc: Scoped,
  table: T,
  rows: readonly Omit<T["$inferInsert"], "accountId" | "id">[],
): number[] {
  if (rows.length === 0) return [];
  const first = reserveIds(sc, getTableName(table) as IdTable, rows.length);
  const ids = rows.map((_, i) => first + i);
  const values = rows.map((row, i) => ({ ...row, accountId: sc.accountId, id: ids[i] }));
  (sc.db as Tx)
    .insert(table)
    .values(values as never)
    .run();
  return ids;
}

/** Inserts one row into an id table of the scope's account and returns its id. */
export const insertOwnedRow = <T extends IdTableDef>(
  sc: Scoped,
  table: T,
  row: Omit<T["$inferInsert"], "accountId" | "id">,
): number => insertOwned(sc, table, [row])[0] as number;

/** Priority labels every account starts with (the user may change or delete them later). */
export const SEED_LABELS = [
  { value: "critical", color: "#F2555A", rank: 0 },
  { value: "high", color: "#FFB224", rank: 1 },
  { value: "medium", color: "#9AA4B2", rank: 2 },
  { value: "low", color: "#5B6573", rank: 3 },
] as const;

/**
 * Seeds a new account (called when an account becomes active: approve, setup), inside the caller's
 * transaction. Labels that already exist (by name, any case) are left alone, so a second call is harmless.
 */
export function seedAccount(tx: Tx, accountId: number, at: string): void {
  const sc: Scoped = { db: tx, accountId };
  const existing = new Set(
    tx
      .select({ nameKey: labels.nameKey })
      .from(labels)
      .where(owned(sc, labels))
      .all()
      .map((l) => l.nameKey),
  );
  const rows = SEED_LABELS.map((l) => Object.assign({}, l, { name: `priority::${l.value}` }))
    .filter((l) => !existing.has(foldCase(l.name)))
    .map((l) => ({
      name: l.name,
      nameKey: foldCase(l.name),
      scope: "priority",
      value: l.value,
      color: l.color,
      description: "",
      rank: l.rank,
      createdAt: at,
      updatedAt: at,
    }));
  insertOwned(sc, labels, rows);
}
