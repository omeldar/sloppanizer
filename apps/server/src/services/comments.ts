import type Database from "better-sqlite3";
import { type Comment, SESSION_ACTOR } from "@organizer/shared";
import { asc, eq } from "drizzle-orm";
import { comments, todos } from "../db/schema.ts";
import { ApiError, notFound } from "../http/errors.ts";
import { type Auth, type Ctx, inTx, now, type Scoped } from "./context.ts";
import { insertOwnedRow, owned } from "./owned.ts";
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

const commentRow = (sc: Scoped, id: number): CommentRow | undefined =>
  sc.db
    .select()
    .from(comments)
    .where(owned(sc, comments, eq(comments.id, id)))
    .get();

function assertTodo(sc: Scoped, todoId: number): void {
  if (
    !sc.db
      .select({ id: todos.id })
      .from(todos)
      .where(owned(sc, todos, eq(todos.id, todoId)))
      .get()
  )
    throw notFound("Todo", todoId);
}

/** Comment rows of a todo, oldest first. */
export function commentRows(sc: Scoped, todoId: number): CommentRow[] {
  return sc.db
    .select()
    .from(comments)
    .where(owned(sc, comments, eq(comments.todoId, todoId)))
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .all();
}

export function listComments(sc: Scoped, todoId: number): Comment[] {
  assertTodo(sc, todoId);
  return commentRows(sc, todoId).map(toComment);
}

/** Adds a comment by the caller (name for display, session or token id for ownership); the todo's last activity moves, its updatedAt does not. */
export function createComment(ctx: Ctx, auth: Auth, todoId: number, bodyMd: string): Comment {
  return ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    assertTodo(sc, todoId);
    const at = now(ctx);
    const id = insertOwnedRow(sc, comments, {
      todoId,
      actor: auth.actor,
      authorKind: auth.via,
      authorTokenId: auth.via === "token" ? auth.tokenId : null,
      bodyMd,
      createdAt: at,
      updatedAt: at,
    });
    sc.db
      .update(todos)
      .set({ lastActivityAt: at })
      .where(owned(sc, todos, eq(todos.id, todoId)))
      .run();
    indexComment(sc, id);
    return toComment(commentRow(sc, id) as CommentRow);
  });
}

/**
 * The session may change any comment; a token only the ones it wrote itself (by token id, so a new
 * token that reuses a revoked token's name does not take over its comments).
 */
function writableComment(sc: Scoped, auth: Auth, id: number): CommentRow {
  const row = commentRow(sc, id);
  if (!row) throw notFound("Comment", id);
  if (auth.via === "token" && (row.authorKind !== "token" || row.authorTokenId !== auth.tokenId)) {
    throw new ApiError(
      "forbidden",
      `This comment was written by ${row.actor}; a token can only change its own comments.`,
    );
  }
  return row;
}

export function updateComment(ctx: Ctx, auth: Auth, id: number, bodyMd: string): Comment {
  return ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    const current = writableComment(sc, auth, id);
    if (current.bodyMd === bodyMd) return toComment(current);
    const at = now(ctx);
    const row = sc.db
      .update(comments)
      .set({ bodyMd, updatedAt: at, editedAt: at })
      .where(owned(sc, comments, eq(comments.id, id)))
      .returning()
      .get() as CommentRow;
    indexComment(sc, id);
    return toComment(row);
  });
}

/** Deletes a comment for good. */
export function deleteComment(ctx: Ctx, auth: Auth, id: number): void {
  ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    writableComment(sc, auth, id);
    sc.db
      .delete(comments)
      .where(owned(sc, comments, eq(comments.id, id)))
      .run();
    removeFromIndex(sc, "comment", id);
  });
}

/**
 * Links token comments of an account to its tokens again after a restore (token ids are not in exports,
 * the account's tokens stay as they are): the account's token with the comment's name that was active
 * when the comment was written, the newest one if several; none means no token owns the comment.
 */
export function linkCommentAuthors(sqlite: Database.Database, accountId: number): void {
  sqlite
    .prepare(
      `UPDATE comments SET author_token_id = (
        SELECT t.id FROM api_tokens t
        WHERE t.account_id = comments.account_id AND t.name = comments.actor
          AND t.created_at <= comments.created_at
          AND (t.revoked_at IS NULL OR t.revoked_at >= comments.created_at)
        ORDER BY t.created_at DESC, t.id DESC LIMIT 1
      ) WHERE account_id = ? AND author_kind = 'token'`,
    )
    .run(accountId);
}

/** Author kind of a comment row from an export without it (format 3 and older): follows the name. */
export const authorKindOf = (actor: unknown): "session" | "token" =>
  actor === SESSION_ACTOR ? "session" : "token";
