import type { Comment } from "@organizer/shared";
import { asc, eq } from "drizzle-orm";
import { comments, todos } from "../db/schema.ts";
import { ApiError, notFound } from "../http/errors.ts";
import { type Auth, type Ctx, now, type Tx } from "./context.ts";
import { indexComment, removeFromIndex } from "./search-index.ts";

export type CommentRow = typeof comments.$inferSelect;

export const toComment = (row: CommentRow): Comment => ({
  id: row.id,
  todoId: row.todoId,
  actor: row.actor,
  bodyMd: row.bodyMd,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  editedAt: row.editedAt,
});

function assertTodo(db: Tx, todoId: number): void {
  if (!db.select({ id: todos.id }).from(todos).where(eq(todos.id, todoId)).get())
    throw notFound("Todo", todoId);
}

/** Comment rows of a todo, oldest first. */
export function commentRows(db: Tx, todoId: number): CommentRow[] {
  return db
    .select()
    .from(comments)
    .where(eq(comments.todoId, todoId))
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .all();
}

export function listComments(db: Tx, todoId: number): Comment[] {
  assertTodo(db, todoId);
  return commentRows(db, todoId).map(toComment);
}

/** Adds a comment; the todo's last activity moves, its updatedAt does not. */
export function createComment(ctx: Ctx, actor: string, todoId: number, bodyMd: string): Comment {
  return ctx.db.transaction((tx) => {
    assertTodo(tx, todoId);
    const at = now(ctx);
    const row = tx
      .insert(comments)
      .values({ todoId, actor, bodyMd, createdAt: at, updatedAt: at })
      .returning()
      .get();
    tx.update(todos).set({ lastActivityAt: at }).where(eq(todos.id, todoId)).run();
    indexComment(tx, row.id);
    return toComment(row);
  });
}

/** The session may change any comment; a token only the ones written under its own name. */
function writableComment(tx: Tx, auth: Auth, id: number): CommentRow {
  const row = tx.select().from(comments).where(eq(comments.id, id)).get();
  if (!row) throw notFound("Comment", id);
  if (auth.via === "token" && row.actor !== auth.actor) {
    throw new ApiError(
      "forbidden",
      `This comment was written by ${row.actor}; a token can only change its own comments.`,
    );
  }
  return row;
}

export function updateComment(ctx: Ctx, auth: Auth, id: number, bodyMd: string): Comment {
  return ctx.db.transaction((tx) => {
    const current = writableComment(tx, auth, id);
    if (current.bodyMd === bodyMd) return toComment(current);
    const at = now(ctx);
    const row = tx
      .update(comments)
      .set({ bodyMd, updatedAt: at, editedAt: at })
      .where(eq(comments.id, id))
      .returning()
      .get() as CommentRow;
    indexComment(tx, id);
    return toComment(row);
  });
}

/** Deletes a comment for good. */
export function deleteComment(ctx: Ctx, auth: Auth, id: number): void {
  ctx.db.transaction((tx) => {
    writableComment(tx, auth, id);
    tx.delete(comments).where(eq(comments.id, id)).run();
    removeFromIndex(tx, "comment", id);
  });
}
