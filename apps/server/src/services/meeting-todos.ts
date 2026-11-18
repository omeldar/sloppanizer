import {
  MAX_MEETING_TODOS,
  type MeetingTodo,
  type MeetingTodoInput,
  type MeetingTodos,
  type Todo,
  type TodoMeeting,
  type TodoRef,
} from "@organizer/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { meetings, meetingTodos, todos } from "../db/schema.ts";
import { ApiError, notFound } from "../http/errors.ts";
import { type Ctx, inTx, now, type Scoped } from "./context.ts";
import { meetingRow, nextDays } from "./meeting-data.ts";
import { owned } from "./owned.ts";
import { projectRefs } from "./projects.ts";
import { chunks } from "./sql.ts";
import { updateTodo } from "./todos.ts";

/**
 * Todos added by hand to a meeting (fixed topics). They stay on every date until the user removes them:
 * ticks and the standup rules never touch them, and adding one never changes its due date. Only the
 * "Due at next meeting" button sets the due date, to the day of the meeting's next date.
 */

interface Brief {
  ref: TodoRef;
  projectId: number | null;
  parentId: number | null;
  dueOn: string | null;
}

/** The account's todos with these ids. */
function briefs(sc: Scoped, ids: readonly number[]): Map<number, Brief> {
  const out = new Map<number, Brief>();
  for (const part of chunks([...new Set(ids)])) {
    for (const t of sc.db
      .select({
        id: todos.id,
        title: todos.title,
        status: todos.status,
        projectId: todos.projectId,
        parentId: todos.parentId,
        dueOn: todos.dueOn,
      })
      .from(todos)
      .where(owned(sc, todos, inArray(todos.id, part)))
      .all()) {
      out.set(t.id, {
        ref: { id: t.id, title: t.title, status: t.status },
        projectId: t.projectId,
        parentId: t.parentId,
        dueOn: t.dueOn,
      });
    }
  }
  return out;
}

function todoBrief(sc: Scoped, id: number): Brief {
  const brief = briefs(sc, [id]).get(id);
  if (!brief) throw notFound("Todo", id);
  return brief;
}

function toMeetingTodos(sc: Scoped, rows: readonly { todoId: number; addedAt: string }[]): MeetingTodo[] {
  const found = briefs(
    sc,
    rows.map((r) => r.todoId),
  );
  const parents = briefs(
    sc,
    [...found.values()].flatMap((b) => (b.parentId === null ? [] : [b.parentId])),
  );
  const projects = projectRefs(
    sc,
    [...found.values()].map((b) => b.projectId),
  );
  return rows.flatMap((row) => {
    const brief = found.get(row.todoId);
    if (!brief) return [];
    return [
      {
        todo: brief.ref,
        project: brief.projectId === null ? null : (projects.get(brief.projectId) ?? null),
        parent: brief.parentId === null ? null : (parents.get(brief.parentId)?.ref ?? null),
        dueOn: brief.dueOn,
        addedAt: row.addedAt,
      },
    ];
  });
}

const linkOf = (sc: Scoped, meetingId: number, todoId: number) =>
  sc.db
    .select({ todoId: meetingTodos.todoId, addedAt: meetingTodos.addedAt })
    .from(meetingTodos)
    .where(owned(sc, meetingTodos, eq(meetingTodos.meetingId, meetingId), eq(meetingTodos.todoId, todoId)))
    .get();

const notOnMeeting = (meetingId: number, todoId: number) =>
  new ApiError("not_found", `Todo ${todoId} is not on meeting ${meetingId}. Check the ids.`);

const nextDay = (ctx: Ctx, sc: Scoped, meetingId: number): string | null =>
  nextDays(sc, [meetingId], ctx.clock(), ctx.timeZone).get(meetingId) ?? null;

/** The meeting's todos, the first added first, with the day "Due at next meeting" would set. */
export function listMeetingTodos(ctx: Ctx, id: number): MeetingTodos {
  meetingRow(ctx, id);
  const rows = ctx.db
    .select({ todoId: meetingTodos.todoId, addedAt: meetingTodos.addedAt })
    .from(meetingTodos)
    .where(owned(ctx, meetingTodos, eq(meetingTodos.meetingId, id)))
    .orderBy(asc(meetingTodos.addedAt), asc(meetingTodos.todoId))
    .all();
  return { meetingId: id, nextOn: nextDay(ctx, ctx, id), items: toMeetingTodos(ctx, rows) };
}

/** Adds a todo of the account to the meeting; 409 when it is on it already. Its due date stays. */
export function addMeetingTodo(ctx: Ctx, id: number, input: MeetingTodoInput): MeetingTodo {
  return ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    meetingRow(sc, id);
    todoBrief(sc, input.todoId);
    if (linkOf(sc, id, input.todoId))
      throw new ApiError("conflict", `Todo ${input.todoId} is on this meeting already.`);
    const count = sc.db.get<{ n: number }>(
      sql`SELECT count(*) AS n FROM ${meetingTodos} WHERE ${owned(sc, meetingTodos, eq(meetingTodos.meetingId, id))}`,
    ).n;
    if (count >= MAX_MEETING_TODOS)
      throw new ApiError(
        "validation_failed",
        `A meeting can have at most ${MAX_MEETING_TODOS} todos. Remove one first.`,
      );
    const addedAt = now(ctx);
    sc.db
      .insert(meetingTodos)
      .values({ accountId: sc.accountId, meetingId: id, todoId: input.todoId, addedAt })
      .run();
    return toMeetingTodos(sc, [{ todoId: input.todoId, addedAt }])[0] as MeetingTodo;
  });
}

/** Takes a todo off the meeting; the todo itself stays. */
export function removeMeetingTodo(ctx: Ctx, id: number, todoId: number): void {
  ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    meetingRow(sc, id);
    const result = sc.db
      .delete(meetingTodos)
      .where(owned(sc, meetingTodos, eq(meetingTodos.meetingId, id), eq(meetingTodos.todoId, todoId)))
      .run();
    if (result.changes === 0) throw notOnMeeting(id, todoId);
  });
}

/**
 * "Due at next meeting": sets the todo's due date to the day of the meeting's next date (cancelled
 * dates skipped, a moved one on the day it moved to). 409 when the meeting has no next date.
 */
export function dueAtNextMeeting(ctx: Ctx, actor: string, id: number, todoId: number): Todo {
  const meeting = meetingRow(ctx, id);
  if (!linkOf(ctx, id, todoId)) throw notOnMeeting(id, todoId);
  const dueOn = nextDay(ctx, ctx, id);
  if (dueOn === null)
    throw new ApiError(
      "conflict",
      `${meeting.name} has no next date, so there is no day to set as due date.`,
    );
  return updateTodo(ctx, actor, todoId, { dueOn });
}

/** Earlier days first, no day last. */
const byDay = (a: string | null, b: string | null): number => {
  if (a === b) return 0;
  if (a === null || b === null) return a === null ? 1 : -1;
  return a < b ? -1 : 1;
};

/** The meetings a todo of the account was added to, the next one first (without a next date last). */
export function listTodoMeetings(ctx: Ctx, todoId: number): TodoMeeting[] {
  todoBrief(ctx, todoId);
  const rows = ctx.db
    .select({
      id: meetings.id,
      name: meetings.name,
      type: meetings.type,
      addedAt: meetingTodos.addedAt,
    })
    .from(meetingTodos)
    .innerJoin(
      meetings,
      and(eq(meetings.accountId, meetingTodos.accountId), eq(meetings.id, meetingTodos.meetingId)),
    )
    .where(owned(ctx, meetingTodos, eq(meetingTodos.todoId, todoId)))
    .all();
  const next = nextDays(
    ctx,
    rows.map((r) => r.id),
    ctx.clock(),
    ctx.timeZone,
  );
  return rows
    .map((r) => ({
      meeting: { id: r.id, name: r.name, type: r.type },
      nextOn: next.get(r.id) ?? null,
      addedAt: r.addedAt,
    }))
    .toSorted((a, b) => byDay(a.nextOn, b.nextOn) || a.meeting.name.localeCompare(b.meeting.name));
}
