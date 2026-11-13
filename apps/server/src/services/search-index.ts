import type { SearchKind } from "@organizer/shared";
import { type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import type { Scoped } from "./context.ts";

/**
 * The full text index (search_fts, FTS5 trigram) of every account. Services call these in the same
 * transaction as the change; rebuildSearchIndex runs at every start so the index heals itself. Each row's
 * rowid encodes account, kind and id ((account id * 2^32 + id) * 4 + kind number), so updates and deletes
 * hit one row directly and two accounts' rows with the same id never collide. Every search query also
 * filters account_id.
 */

const KIND_NUMBER: Record<SearchKind, number> = { todo: 0, note: 1, comment: 2, person: 3 };
const ACCOUNT_SPAN = 2 ** 32;

export const searchRowId = (accountId: number, kind: SearchKind, refId: number): number =>
  (accountId * ACCOUNT_SPAN + refId) * 4 + KIND_NUMBER[kind];

const rowIdSql = (kind: SearchKind): SQL =>
  sql.raw(`(account_id * ${ACCOUNT_SPAN} + id) * 4 + ${KIND_NUMBER[kind]}`);

/** SELECTs that produce index rows (rowid, account_id, kind, ref_id, todo_id, title, body), one per kind. */
const SOURCES: Record<SearchKind, (where: SQL) => SQL> = {
  todo: (where) =>
    sql`SELECT ${rowIdSql("todo")}, account_id, 'todo', id, id, title, description_md FROM todos WHERE ${where}`,
  note: (where) =>
    sql`SELECT ${rowIdSql("note")}, account_id, 'note', id, NULL, title, body_md FROM notes WHERE ${where}`,
  comment: (where) =>
    sql`SELECT ${rowIdSql("comment")}, account_id, 'comment', id, todo_id, '', body_md FROM comments WHERE ${where}`,
  person: (where) => sql`SELECT ${rowIdSql("person")}, account_id, 'person', id, NULL,
      first_name || ' ' || last_name,
      team || char(10) || email || char(10) || note || char(10) || coalesce((
        SELECT group_concat(t.name, char(10)) FROM person_topics pt
        JOIN topics t ON t.account_id = pt.account_id AND t.id = pt.topic_id
        WHERE pt.account_id = people.account_id AND pt.person_id = people.id), '')
    FROM people WHERE ${where}`,
};

const insertFrom = (source: SQL): SQL =>
  sql`INSERT INTO search_fts (rowid, account_id, kind, ref_id, todo_id, title, body) ${source}`;

/** Removes one row of the scope's account from the index (no error when it is not there). */
export function removeFromIndex(sc: Scoped, kind: SearchKind, refId: number): void {
  sc.db.run(sql`DELETE FROM search_fts WHERE rowid = ${searchRowId(sc.accountId, kind, refId)}`);
}

function reindex(sc: Scoped, kind: SearchKind, refId: number): void {
  removeFromIndex(sc, kind, refId);
  sc.db.run(insertFrom(SOURCES[kind](sql`account_id = ${sc.accountId} AND id = ${refId}`)));
}

export const indexTodo = (sc: Scoped, id: number): void => reindex(sc, "todo", id);
export const indexNote = (sc: Scoped, id: number): void => reindex(sc, "note", id);
export const indexComment = (sc: Scoped, id: number): void => reindex(sc, "comment", id);
export const indexPerson = (sc: Scoped, id: number): void => reindex(sc, "person", id);

export function reindexPeople(sc: Scoped, ids: readonly number[]): void {
  for (const id of ids) indexPerson(sc, id);
}

/** Removes a todo of the scope's account and the rows of its comments. */
export function removeTodoFromIndex(sc: Scoped, todoId: number): void {
  sc.db.run(sql`DELETE FROM search_fts WHERE account_id = ${sc.accountId} AND todo_id = ${todoId}`);
}

/** Rebuilds the index of one account (after a restore), inside the caller's transaction. */
export function rebuildAccountIndex(sc: Scoped): void {
  sc.db.run(sql`DELETE FROM search_fts WHERE account_id = ${sc.accountId}`);
  for (const source of Object.values(SOURCES)) {
    sc.db.run(insertFrom(source(sql`account_id = ${sc.accountId}`)));
  }
}

/** Rebuilds the whole index (every account) from the tables in one transaction. */
export function rebuildSearchIndex(db: Db): void {
  db.transaction((tx) => {
    tx.run(sql`DELETE FROM search_fts`);
    for (const source of Object.values(SOURCES)) tx.run(insertFrom(source(sql`1 = 1`)));
  });
}

/** Removes every index row of an account (account delete; the rows do not cascade from accounts). */
export function removeAccountFromIndex(tx: Pick<Scoped["db"], "run">, accountId: number): void {
  tx.run(sql`DELETE FROM search_fts WHERE account_id = ${accountId}`);
}
