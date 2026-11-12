import type { SearchKind } from "@organizer/shared";
import { type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import type { Tx } from "./context.ts";

/**
 * The full text index (search_fts, FTS5 trigram). Services call these in the same transaction as the
 * change; rebuildSearchIndex runs at every start so the index heals itself. Each row's rowid encodes
 * kind and id (id * 4 + kind number), so updates and deletes hit one row directly.
 */

const KIND_NUMBER: Record<SearchKind, number> = { todo: 0, note: 1, comment: 2, person: 3 };

export const searchRowId = (kind: SearchKind, refId: number): number => refId * 4 + KIND_NUMBER[kind];

/** SELECTs that produce index rows (rowid, kind, ref_id, todo_id, title, body), one per kind. */
const SOURCES: Record<SearchKind, (where: SQL) => SQL> = {
  todo: (where) => sql`SELECT id * 4 + 0, 'todo', id, id, title, description_md FROM todos WHERE ${where}`,
  note: (where) => sql`SELECT id * 4 + 1, 'note', id, NULL, title, body_md FROM notes WHERE ${where}`,
  comment: (where) =>
    sql`SELECT id * 4 + 2, 'comment', id, todo_id, '', body_md FROM comments WHERE ${where}`,
  person: (where) => sql`SELECT id * 4 + 3, 'person', id, NULL, first_name || ' ' || last_name,
      team || char(10) || email || char(10) || note || char(10) || coalesce((
        SELECT group_concat(t.name, char(10)) FROM person_topics pt JOIN topics t ON t.id = pt.topic_id
        WHERE pt.person_id = people.id), '')
    FROM people WHERE ${where}`,
};

const insertFrom = (source: SQL): SQL =>
  sql`INSERT INTO search_fts (rowid, kind, ref_id, todo_id, title, body) ${source}`;

/** Removes one row from the index (no error when it is not there). */
export function removeFromIndex(tx: Tx, kind: SearchKind, refId: number): void {
  tx.run(sql`DELETE FROM search_fts WHERE rowid = ${searchRowId(kind, refId)}`);
}

function reindex(tx: Tx, kind: SearchKind, refId: number): void {
  removeFromIndex(tx, kind, refId);
  tx.run(insertFrom(SOURCES[kind](sql`id = ${refId}`)));
}

export const indexTodo = (tx: Tx, id: number): void => reindex(tx, "todo", id);
export const indexNote = (tx: Tx, id: number): void => reindex(tx, "note", id);
export const indexComment = (tx: Tx, id: number): void => reindex(tx, "comment", id);
export const indexPerson = (tx: Tx, id: number): void => reindex(tx, "person", id);

export function reindexPeople(tx: Tx, ids: readonly number[]): void {
  for (const id of ids) indexPerson(tx, id);
}

/** Removes a todo and the rows of its comments. */
export function removeTodoFromIndex(tx: Tx, todoId: number): void {
  tx.run(sql`DELETE FROM search_fts WHERE todo_id = ${todoId}`);
}

/** Rebuilds the whole index from the tables in one transaction. */
export function rebuildSearchIndex(db: Db): void {
  db.transaction((tx) => {
    tx.run(sql`DELETE FROM search_fts`);
    for (const source of Object.values(SOURCES)) tx.run(insertFrom(source(sql`1 = 1`)));
  });
}
