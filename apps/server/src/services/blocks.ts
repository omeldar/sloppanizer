import {
  addDays,
  checkSpan,
  type CreateTimeBlock,
  startOfLocalDay,
  type TimeBlock,
  type TimeBlockQuery,
  type TodoStatus,
  type UpdateTimeBlock,
} from "@organizer/shared";
import { and, asc, eq, gt, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import { timeBlocks, todos } from "../db/schema.ts";
import { ApiError, notFound } from "../http/errors.ts";
import { type Ctx, inTx, now, type Scoped } from "./context.ts";
import { insertOwnedRow, owned } from "./owned.ts";
import { projectRefs } from "./projects.ts";
import { chunks } from "./sql.ts";

/** Planner: time reserved for a todo or with its own title. */

type BlockRow = typeof timeBlocks.$inferSelect;

interface TodoBrief {
  id: number;
  title: string;
  status: TodoStatus;
  projectId: number | null;
}

function hydrateBlocks(sc: Scoped, rows: readonly BlockRow[]): TimeBlock[] {
  const todoIds = [...new Set(rows.flatMap((r) => (r.todoId === null ? [] : [r.todoId])))];
  const todoById = new Map<number, TodoBrief>();
  for (const part of chunks(todoIds)) {
    for (const t of sc.db
      .select({ id: todos.id, title: todos.title, status: todos.status, projectId: todos.projectId })
      .from(todos)
      .where(owned(sc, todos, inArray(todos.id, part)))
      .all()) {
      todoById.set(t.id, t);
    }
  }
  const projects = projectRefs(
    sc,
    [...todoById.values()].map((t) => t.projectId),
  );
  return rows.map((row) => {
    const todo = row.todoId === null ? undefined : todoById.get(row.todoId);
    return {
      id: row.id,
      todoId: row.todoId,
      title: row.title,
      startAt: row.startAt,
      endAt: row.endAt,
      todo: todo ? { id: todo.id, title: todo.title, status: todo.status } : null,
      project: todo?.projectId == null ? null : (projects.get(todo.projectId) ?? null),
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });
}

function assertTodo(sc: Scoped, todoId: number | null | undefined): void {
  if (todoId === null || todoId === undefined) return;
  const row = sc.db
    .select({ id: todos.id })
    .from(todos)
    .where(owned(sc, todos, eq(todos.id, todoId)))
    .get();
  if (!row) throw notFound("Todo", todoId);
}

function blockRow(sc: Scoped, id: number): BlockRow {
  const row = sc.db
    .select()
    .from(timeBlocks)
    .where(owned(sc, timeBlocks, eq(timeBlocks.id, id)))
    .get();
  if (!row) throw notFound("Time block", id);
  return row;
}

/** Blocks that overlap the days from..to (account time zone), by start. */
export function listBlocks(ctx: Ctx, query: TimeBlockQuery): TimeBlock[] {
  const start = startOfLocalDay(query.from, ctx.timeZone).toISOString();
  const end = startOfLocalDay(addDays(query.to, 1), ctx.timeZone).toISOString();
  const rows = ctx.db
    .select()
    .from(timeBlocks)
    .where(
      owned(
        ctx,
        timeBlocks,
        and(
          lt(timeBlocks.startAt, end),
          gt(timeBlocks.endAt, start),
          query.todoId === undefined ? undefined : eq(timeBlocks.todoId, query.todoId),
        ),
      ),
    )
    .orderBy(asc(timeBlocks.startAt), asc(timeBlocks.id))
    .all();
  return hydrateBlocks(ctx, rows);
}

export function createBlock(ctx: Ctx, actor: string, input: CreateTimeBlock): TimeBlock {
  return ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    assertTodo(sc, input.todoId);
    const at = now(ctx);
    const id = insertOwnedRow(sc, timeBlocks, {
      todoId: input.todoId ?? null,
      title: input.title ?? "",
      startAt: input.startAt,
      endAt: input.endAt,
      createdBy: actor,
      createdAt: at,
      updatedAt: at,
    });
    return hydrateBlocks(sc, [blockRow(sc, id)])[0] as TimeBlock;
  });
}

/** The span and "todo or title" rules again, on the merged block. */
const MergedBlock = z
  .object({ todoId: z.number().nullable(), title: z.string(), startAt: z.string(), endAt: z.string() })
  .superRefine((value, ctx) => {
    if (value.todoId === null && value.title === "") {
      ctx.addIssue({ code: "custom", message: "Pick a todo or give the block a title." });
    }
    checkSpan(ctx, value.startAt, value.endAt);
  });

export function updateBlock(ctx: Ctx, id: number, input: UpdateTimeBlock): TimeBlock {
  return ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    const row = blockRow(sc, id);
    assertTodo(sc, input.todoId);
    const next = {
      todoId: input.todoId === undefined ? row.todoId : input.todoId,
      title: input.title ?? row.title,
      startAt: input.startAt ?? row.startAt,
      endAt: input.endAt ?? row.endAt,
    };
    const result = MergedBlock.safeParse(next);
    if (!result.success) {
      throw new ApiError("validation_failed", result.error.issues.map((i) => i.message).join(" "));
    }
    tx.update(timeBlocks)
      .set({ ...next, updatedAt: now(ctx) })
      .where(owned(sc, timeBlocks, eq(timeBlocks.id, id)))
      .run();
    return hydrateBlocks(sc, [blockRow(sc, id)])[0] as TimeBlock;
  });
}

export function deleteBlock(ctx: Ctx, id: number): void {
  ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    blockRow(sc, id);
    tx.delete(timeBlocks)
      .where(owned(sc, timeBlocks, eq(timeBlocks.id, id)))
      .run();
  });
}
