import type { Todo, TodoUrl, UpdateUrl, UrlInput } from "@organizer/shared";
import { and, asc, eq, inArray, max } from "drizzle-orm";
import { todoUrls } from "../db/schema.ts";
import { notFound } from "../http/errors.ts";
import { ApiError } from "../http/errors.ts";
import { type Ctx, inTx, now, type Scoped } from "./context.ts";
import { insertOwned, owned } from "./owned.ts";
import { chunks } from "./sql.ts";
import { getTodo, touchTodos } from "./todos.ts";

/** Web links of todos: a URL and an optional label, ordered by position. */

export const MAX_URLS_PER_TODO = 50;

/** The links of each todo, in order. */
export function urlsByTodo(sc: Scoped, ids: readonly number[]): Map<number, TodoUrl[]> {
  const byTodo = new Map<number, TodoUrl[]>();
  for (const part of chunks([...ids])) {
    for (const row of sc.db
      .select()
      .from(todoUrls)
      .where(owned(sc, todoUrls, inArray(todoUrls.todoId, part)))
      .orderBy(asc(todoUrls.position), asc(todoUrls.id))
      .all()) {
      const list = byTodo.get(row.todoId) ?? [];
      list.push({ id: row.id, url: row.url, label: row.label });
      byTodo.set(row.todoId, list);
    }
  }
  return byTodo;
}

/** Appends links to a todo (inside the caller's transaction). Duplicates of a URL it has are skipped. */
export function insertUrls(sc: Scoped, at: string, todoId: number, inputs: readonly UrlInput[]): void {
  if (inputs.length === 0) return;
  const existing = sc.db
    .select({ url: todoUrls.url })
    .from(todoUrls)
    .where(owned(sc, todoUrls, eq(todoUrls.todoId, todoId)))
    .all()
    .map((r) => r.url);
  const seen = new Set(existing);
  const fresh = inputs.filter((input) => !seen.has(input.url) && seen.add(input.url));
  if (existing.length + fresh.length > MAX_URLS_PER_TODO) {
    throw new ApiError("validation_failed", `A todo has at most ${MAX_URLS_PER_TODO} links.`);
  }
  const last =
    sc.db
      .select({ p: max(todoUrls.position) })
      .from(todoUrls)
      .where(owned(sc, todoUrls, eq(todoUrls.todoId, todoId)))
      .get()?.p ?? 0;
  insertOwned(
    sc,
    todoUrls,
    fresh.map((input, i) => ({
      todoId,
      url: input.url,
      label: input.label ?? "",
      position: last + i + 1,
      createdAt: at,
    })),
  );
}

export function addUrls(ctx: Ctx, todoId: number, inputs: readonly UrlInput[]): Todo {
  return ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    getTodo(sc, todoId);
    const at = now(ctx);
    insertUrls(sc, at, todoId, inputs);
    touchTodos(sc, at, [todoId]);
    return getTodo(sc, todoId);
  });
}

function urlRow(sc: Scoped, todoId: number, id: number) {
  const row = sc.db
    .select()
    .from(todoUrls)
    .where(owned(sc, todoUrls, and(eq(todoUrls.id, id), eq(todoUrls.todoId, todoId))))
    .get();
  if (!row) throw notFound("Link", id);
  return row;
}

export function updateUrl(ctx: Ctx, todoId: number, id: number, input: UpdateUrl): Todo {
  return ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    urlRow(sc, todoId, id);
    const at = now(ctx);
    tx.update(todoUrls)
      .set({
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.label !== undefined ? { label: input.label } : {}),
      })
      .where(owned(sc, todoUrls, eq(todoUrls.id, id)))
      .run();
    touchTodos(sc, at, [todoId]);
    return getTodo(sc, todoId);
  });
}

export function deleteUrl(ctx: Ctx, todoId: number, id: number): Todo {
  return ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    urlRow(sc, todoId, id);
    tx.delete(todoUrls)
      .where(owned(sc, todoUrls, eq(todoUrls.id, id)))
      .run();
    touchTodos(sc, now(ctx), [todoId]);
    return getTodo(sc, todoId);
  });
}
