import {
  addDays,
  type BlockSpace,
  checkSpan,
  type CreateTimeBlock,
  startOfLocalDay,
  type TimeBlock,
  type TimeBlockQuery,
  type TodoStatus,
  toLocalDate,
  type UpdateTimeBlock,
} from "@organizer/shared";
import { and, asc, eq, gt, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import { accounts } from "../db/auth-schema.ts";
import { timeBlocks, todos } from "../db/schema.ts";
import { ApiError, notFound } from "../http/errors.ts";
import { assigneesById, isSpace, memberSpaceIds } from "./assignees.ts";
import { type Ctx, inTx, now, type Scoped, type Tx } from "./context.ts";
import { insertOwnedRow, owned } from "./owned.ts";
import { projectRefs } from "./projects.ts";
import { assignPlanner, planTodoOn } from "./todos.ts";
import { chunks } from "./sql.ts";

/**
 * Planner: time reserved for a todo or with its own title.
 *
 * A block for a todo of a shared project lives in that project (its account, next to the todo), with the
 * member whose time it is (member_id: who planned it). Inside the project every member sees every
 * block; your own planner adds your blocks of the shared projects you are a member of (shared=true),
 * each changed inside its project like any of its data. Leaving a project deletes your blocks there.
 */

type BlockRow = typeof timeBlocks.$inferSelect;

interface TodoBrief {
  id: number;
  title: string;
  status: TodoStatus;
  projectId: number | null;
  assigneeId: number | null;
}

function hydrateBlocks(sc: Scoped, rows: readonly BlockRow[], space: BlockSpace | null = null): TimeBlock[] {
  const todoIds = [...new Set(rows.flatMap((r) => (r.todoId === null ? [] : [r.todoId])))];
  const todoById = new Map<number, TodoBrief>();
  for (const part of chunks(todoIds)) {
    for (const t of sc.db
      .select({
        id: todos.id,
        title: todos.title,
        status: todos.status,
        projectId: todos.projectId,
        assigneeId: todos.assigneeId,
      })
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
  const people = assigneesById(sc.db, [
    ...rows.map((r) => r.memberId),
    ...[...todoById.values()].map((t) => t.assigneeId),
  ]);
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
      space,
      member: row.memberId === null ? null : (people.get(row.memberId) ?? null),
      assignee: todo?.assigneeId == null ? null : (people.get(todo.assigneeId) ?? null),
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

/** The UTC bounds of the days from..to in the time zone. */
function bounds(query: Pick<TimeBlockQuery, "from" | "to">, timeZone: string): [string, string] {
  return [
    startOfLocalDay(query.from, timeZone).toISOString(),
    startOfLocalDay(addDays(query.to, 1), timeZone).toISOString(),
  ];
}

/**
 * The user's own blocks in the shared projects they are a member of (membership checked here like for
 * a request inside the project), each with its project.
 */
function memberBlocks(tx: Tx, userId: number, query: TimeBlockQuery, timeZone: string): TimeBlock[] {
  const [start, end] = bounds(query, timeZone);
  const list: TimeBlock[] = [];
  for (const spaceId of memberSpaceIds(tx, userId)) {
    const sc: Scoped = { db: tx, accountId: spaceId };
    const rows = tx
      .select()
      .from(timeBlocks)
      .where(
        owned(
          sc,
          timeBlocks,
          eq(timeBlocks.memberId, userId),
          lt(timeBlocks.startAt, end),
          gt(timeBlocks.endAt, start),
        ),
      )
      .orderBy(asc(timeBlocks.startAt), asc(timeBlocks.id))
      .all();
    if (rows.length === 0) continue;
    const space = tx.select().from(accounts).where(eq(accounts.id, spaceId)).get();
    if (!space) continue;
    list.push(...hydrateBlocks(sc, rows, { id: space.id, name: space.displayName, color: space.color }));
  }
  return list;
}

/**
 * Blocks that overlap the days from..to (account time zone), by start. With shared (your own account
 * only, not with todoId) also your blocks in your shared projects.
 */
export function listBlocks(ctx: Ctx, query: TimeBlockQuery): TimeBlock[] {
  const [start, end] = bounds(query, ctx.timeZone);
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
  const own = hydrateBlocks(ctx, rows);
  if (!query.shared || query.todoId !== undefined || isSpace(ctx.db, ctx.accountId)) return own;
  const shared = memberBlocks(ctx.db, ctx.callerId ?? ctx.accountId, query, ctx.timeZone);
  if (shared.length === 0) return own;
  return [...own, ...shared].toSorted(
    (a, b) => a.startAt.localeCompare(b.startAt) || (a.space?.id ?? 0) - (b.space?.id ?? 0) || a.id - b.id,
  );
}

/**
 * The member of a new block: inside a shared project the caller (it is their time), in your own
 * account nobody (every block there is yours).
 */
const memberOf = (sc: Scoped, ctx: Ctx): number | null =>
  ctx.callerId !== undefined && ctx.callerId !== ctx.accountId && isSpace(sc.db, sc.accountId)
    ? ctx.callerId
    : null;

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
      memberId: memberOf(sc, ctx),
    });
    if (input.todoId) {
      planTodoOn(sc, at, actor, input.todoId, toLocalDate(input.startAt, ctx.timeZone), ctx.timeZone);
      assignPlanner(sc, ctx, at, actor, input.todoId, ctx.timeZone);
    }
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

export function updateBlock(ctx: Ctx, actor: string, id: number, input: UpdateTimeBlock): TimeBlock {
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
    const at = now(ctx);
    tx.update(timeBlocks)
      .set({ ...next, updatedAt: at })
      .where(owned(sc, timeBlocks, eq(timeBlocks.id, id)))
      .run();
    // Moved to another day or given to another todo: that todo is planned for the block's day (and, in
    // a shared project, goes to whoever planned it when nobody is on it).
    const day = toLocalDate(next.startAt, ctx.timeZone);
    if (
      next.todoId !== null &&
      (next.todoId !== row.todoId || day !== toLocalDate(row.startAt, ctx.timeZone))
    ) {
      planTodoOn(sc, at, actor, next.todoId, day, ctx.timeZone);
      assignPlanner(sc, ctx, at, actor, next.todoId, ctx.timeZone);
    }
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

/** A member left or was removed: their time in the project goes with them. */
export function deleteMemberBlocks(tx: Tx, spaceId: number, userId: number): void {
  tx.delete(timeBlocks)
    .where(owned({ accountId: spaceId }, timeBlocks, eq(timeBlocks.memberId, userId)))
    .run();
}
