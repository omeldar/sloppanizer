import { eq, max, sql } from "drizzle-orm";
import { todos } from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import type { Scoped } from "./context.ts";
import { owned } from "./owned.ts";

/** Subtasks go at most this many levels deep (a top-level todo is level 1). */
export const MAX_DEPTH = 5;

/** The level of a todo: 1 for a top-level todo, 2 for its subtasks, and so on. */
export function levelOf(sc: Scoped, id: number): number {
  const row = sc.db.get<{ n: number }>(sql`
    WITH RECURSIVE up(id, parent_id) AS (
      SELECT id, parent_id FROM ${todos} WHERE account_id = ${sc.accountId} AND id = ${id}
      UNION ALL
      SELECT t.id, t.parent_id FROM ${todos} t JOIN up ON t.account_id = ${sc.accountId} AND t.id = up.parent_id
    )
    SELECT count(*) AS n FROM up`);
  return row.n;
}

/** How many levels a todo spans with its subtasks: 1 without subtasks. */
export function heightOf(sc: Scoped, id: number): number {
  const row = sc.db.get<{ n: number }>(sql`
    WITH RECURSIVE down(id, depth) AS (
      SELECT ${id}, 1
      UNION ALL
      SELECT t.id, down.depth + 1 FROM ${todos} t
      JOIN down ON t.account_id = ${sc.accountId} AND t.parent_id = down.id
      WHERE down.depth <= ${MAX_DEPTH + 1}
    )
    SELECT max(depth) AS n FROM down`);
  return row.n;
}

/** Ids of every subtask below a todo (children, their children, ...). */
export function descendantIds(sc: Scoped, id: number): number[] {
  return sc.db
    .all<{ id: number }>(sql`
      WITH RECURSIVE down(id) AS (
        SELECT id FROM ${todos} WHERE account_id = ${sc.accountId} AND parent_id = ${id}
        UNION
        SELECT t.id FROM ${todos} t JOIN down ON t.account_id = ${sc.accountId} AND t.parent_id = down.id
      )
      SELECT id FROM down`)
    .map((r) => r.id);
}

/**
 * A todo may become a subtask of `parentId` when the parent exists, is not the todo itself or one
 * of its subtasks, and the result stays within 5 levels. `childId` null checks a new todo.
 */
export function assertCanBeParent(sc: Scoped, childId: number | null, parentId: number): void {
  const exists = sc.db.get<{ n: number }>(
    sql`SELECT count(*) AS n FROM ${todos} WHERE account_id = ${sc.accountId} AND id = ${parentId}`,
  );
  if (exists.n === 0) {
    throw new ApiError("validation_failed", `Todo ${parentId} does not exist, so it cannot be the parent.`);
  }
  if (childId !== null && (childId === parentId || descendantIds(sc, childId).includes(parentId))) {
    throw new ApiError("validation_failed", "A todo cannot be a subtask of its own subtask.");
  }
  const height = childId === null ? 1 : heightOf(sc, childId);
  if (levelOf(sc, parentId) + height > MAX_DEPTH) {
    throw new ApiError(
      "validation_failed",
      `Subtasks go at most ${MAX_DEPTH} levels deep. Pick a parent higher up.`,
    );
  }
}

/** Position after the last child of a parent (0 for the first). */
export function nextChildPosition(sc: Scoped, parentId: number): number {
  const last = sc.db
    .select({ p: max(todos.position) })
    .from(todos)
    .where(owned(sc, todos, eq(todos.parentId, parentId)))
    .get();
  return last?.p === null || last?.p === undefined ? 0 : last.p + 1;
}
