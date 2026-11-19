import {
  addDays,
  type BlockDateChange,
  type BlockOccurrence,
  type BlockOccurrenceQuery,
  type BlockSeries,
  canRepeatPlan,
  type CreateBlockSeries,
  daysBetween,
  describeRecurrence,
  describeSeries,
  type ExpandedOccurrence,
  expandSeries,
  formatDate,
  MAX_RECURRING,
  MAX_SEGMENTS,
  nextSeriesOccurrence,
  previousRuleDate,
  type ProjectRef,
  type RecurringTodo,
  type Series,
  type SeriesSpan,
  shiftRule,
  todoForDate,
  type TodoStatus,
  toLocalDate,
  toLocalTime,
} from "@organizer/shared";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { series, todos } from "../db/schema.ts";
import { ApiError, notFound } from "../http/errors.ts";
import { type Ctx, inTx, now, type Scoped } from "./context.ts";
import { owned } from "./owned.ts";
import { projectRefs } from "./projects.ts";
import {
  changeDate,
  checkHasDates,
  exceptionsOf,
  insertSegment,
  loadSeries,
  type OwnerTexts,
  scheduleRule,
  type SeriesOwner,
  segmentsOfOwners,
} from "./series-editor.ts";
import { chunks } from "./sql.ts";
import { hydrate, parseRecurrence } from "./todos.ts";

/**
 * Planned time that repeats with a repeating todo (see shared block-series.ts). A repeat of todos is a
 * chain linked by recurrence_prev_id; its planned time is a series owned by the chain's open todo.
 */

interface Member {
  id: number;
  title: string;
  status: TodoStatus;
  projectId: number | null;
  /** Due date, else planned date. */
  anchor: string | null;
  doneAt: string | null;
  recurrence: string | null;
  prevId: number | null;
}

const memberColumns = {
  id: todos.id,
  title: todos.title,
  status: todos.status,
  projectId: todos.projectId,
  dueOn: todos.dueOn,
  plannedOn: todos.plannedOn,
  doneAt: todos.doneAt,
  recurrence: todos.recurrence,
  prevId: todos.recurrencePrevId,
};

type MemberRow = {
  id: number;
  title: string;
  status: TodoStatus;
  projectId: number | null;
  dueOn: string | null;
  plannedOn: string | null;
  doneAt: string | null;
  recurrence: string | null;
  prevId: number | null;
};

const toMember = (r: MemberRow): Member => ({
  id: r.id,
  title: r.title,
  status: r.status,
  projectId: r.projectId,
  anchor: r.dueOn ?? r.plannedOn,
  doneAt: r.doneAt,
  recurrence: r.recurrence,
  prevId: r.prevId,
});

/** Chains of todos linked by recurrence_prev_id, oldest first, from every row that is part of one. */
function chainsOf(rows: readonly Member[]): Member[][] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const nextOf = new Map<number, Member>();
  for (const r of rows) if (r.prevId !== null && byId.has(r.prevId)) nextOf.set(r.prevId, r);
  const out: Member[][] = [];
  for (const root of rows.filter((r) => r.prevId === null || !byId.has(r.prevId))) {
    const chain = [root];
    for (let at = nextOf.get(root.id); at && chain.length <= rows.length; at = nextOf.get(at.id))
      chain.push(at);
    out.push(chain);
  }
  return out;
}

/**
 * Every todo of the account that is part of a repeat: it has a rule, came from one, or owns planned
 * time (a stopped repeat keeps its past dates).
 */
function allChains(sc: Scoped): Member[][] {
  const planOwners = sc.db
    .select({ id: series.todoId })
    .from(series)
    .where(owned(sc, series, eq(series.ownerKind, "todo")));
  const rows = sc.db
    .select(memberColumns)
    .from(todos)
    .where(
      owned(
        sc,
        todos,
        or(isNotNull(todos.recurrence), isNotNull(todos.recurrencePrevId), inArray(todos.id, planOwners)),
      ),
    )
    .all()
    .map(toMember);
  // A todo whose next one has no rule (the repeat was stopped there) is still the chain's start.
  const prevIds = [...new Set(rows.flatMap((r) => (r.prevId === null ? [] : [r.prevId])))];
  const known = new Set(rows.map((r) => r.id));
  const missing = prevIds.filter((id) => !known.has(id));
  for (const part of chunks(missing)) {
    rows.push(
      ...sc.db
        .select(memberColumns)
        .from(todos)
        .where(owned(sc, todos, inArray(todos.id, part)))
        .all()
        .map(toMember),
    );
  }
  return chainsOf(rows);
}

/** The chain of one todo, oldest first; 404 when the todo does not exist. */
function chainOf(sc: Scoped, todoId: number): Member[] {
  const ids = sc.db
    .all<{ id: number }>(
      sql`WITH RECURSIVE
        up(id, prev) AS (
          SELECT id, recurrence_prev_id FROM ${todos} WHERE account_id = ${sc.accountId} AND id = ${todoId}
          UNION
          SELECT t.id, t.recurrence_prev_id FROM ${todos} t JOIN up ON t.account_id = ${sc.accountId} AND t.id = up.prev
        ),
        down(id) AS (
          SELECT id FROM ${todos} WHERE account_id = ${sc.accountId} AND id = ${todoId}
          UNION
          SELECT t.id FROM ${todos} t JOIN down ON t.account_id = ${sc.accountId} AND t.recurrence_prev_id = down.id
        )
      SELECT id FROM up UNION SELECT id FROM down`,
    )
    .map((r) => r.id);
  if (ids.length === 0) throw notFound("Todo", todoId);
  const rows: Member[] = [];
  for (const part of chunks(ids)) {
    rows.push(
      ...sc.db
        .select(memberColumns)
        .from(todos)
        .where(owned(sc, todos, inArray(todos.id, part)))
        .all()
        .map(toMember),
    );
  }
  return chainsOf(rows)[0] ?? [];
}

const TEXTS: OwnerTexts = {
  tooManyParts: `Planned time can have at most ${MAX_SEGMENTS} parts. Change all dates instead of this and following.`,
  cancelFirstDate: "This is the first planned date. Remove the planned time to cancel every date.",
  noDate: (on) => `The todo has no planned time on ${formatDate(on)}.`,
};

/** The todo of the chain that owns its planned time (normally the newest), or null when it has none. */
function ownerOf(sc: Scoped, chain: readonly Member[]): number | null {
  const ids = chain.map((m) => m.id);
  for (const part of chunks(ids)) {
    const row = sc.db
      .select({ todoId: series.todoId })
      .from(series)
      .where(owned(sc, series, and(eq(series.ownerKind, "todo"), inArray(series.todoId, part))))
      .get();
    if (row?.todoId != null) return row.todoId;
  }
  return null;
}

const toSeries = (span: SeriesSpan): Series => ({ ...span, text: describeSeries(span) });

/** The segment that holds today, else the next one, else the last one. */
function currentSegment(segments: readonly SeriesSpan[], today: string): SeriesSpan {
  return (
    segments.find((s) => s.startsOn <= today && (s.endsOn === null || s.endsOn >= today)) ??
    segments.find((s) => s.startsOn > today) ??
    (segments.at(-1) as SeriesSpan)
  );
}

function toOccurrence(
  o: ExpandedOccurrence,
  ownerTodoId: number,
  chain: readonly Member[],
  projects: ReadonlyMap<number, ProjectRef>,
): BlockOccurrence {
  const member = todoForDate(chain, o.occursOn) ?? (chain.at(-1) as Member);
  return {
    seriesId: o.seriesId,
    ownerTodoId,
    todo: { id: member.id, title: member.title, status: member.status },
    project: member.projectId === null ? null : (projects.get(member.projectId) ?? null),
    occursOn: o.occursOn,
    startAt: o.startAt,
    endAt: o.endAt,
    status: o.status,
  };
}

/** The planned time of chains, by owner id (one query per kind of row). */
function plansOf(ctx: Ctx, sc: Scoped, chains: readonly Member[][]): Map<number, BlockSeries> {
  const ownerByChain = new Map<number, Member[]>();
  const segments = segmentsOfOwners(
    sc,
    "todo",
    chains.flatMap((c) => c.map((m) => m.id)),
  );
  for (const chain of chains) {
    const owner = chain.find((m) => (segments.get(m.id)?.length ?? 0) > 0);
    if (owner) ownerByChain.set(owner.id, chain);
  }
  const exceptions = exceptionsOf(
    sc,
    [...ownerByChain.keys()].flatMap((id) => (segments.get(id) ?? []).map((s) => s.id)),
  );
  const projects = projectRefs(
    sc,
    [...ownerByChain.values()].flatMap((c) => c.map((m) => m.projectId)),
  );
  const at = ctx.clock();
  const today = toLocalDate(at, ctx.timeZone);
  const out = new Map<number, BlockSeries>();
  for (const [ownerId, chain] of ownerByChain) {
    const list = segments.get(ownerId) ?? [];
    const own = new Set(list.map((s) => s.id));
    const next = nextSeriesOccurrence(
      list,
      exceptions.filter((e) => own.has(e.seriesId)),
      at,
      ctx.timeZone,
    );
    out.set(ownerId, {
      todoId: ownerId,
      schedule: toSeries(currentSegment(list, today)),
      segments: list.map(toSeries),
      next: next === null ? null : toOccurrence(next, ownerId, chain, projects),
    });
  }
  return out;
}

function planOfChain(ctx: Ctx, sc: Scoped, chain: readonly Member[]): BlockSeries | null {
  const plans = plansOf(ctx, sc, [[...chain]]);
  return [...plans.values()][0] ?? null;
}

const noPlan = (todoId: number) =>
  new ApiError("not_found", `Todo ${todoId} has no planned time that repeats. Plan time for it first.`);

export function getRepeatPlan(ctx: Ctx, todoId: number, sc: Scoped = ctx): BlockSeries {
  const plan = planOfChain(ctx, sc, chainOf(sc, todoId));
  if (!plan) throw noPlan(todoId);
  return plan;
}

/**
 * Where the repeat's dates fall when the first planned date is `startsOn`: the todo's rule, its days
 * moved by as many days as the planned date is from the todo's date of that week (or month), so time
 * planned on Tuesday for a Monday todo comes back every Tuesday.
 */
function planRule(open: Member, startsOn: string) {
  const rule = parseRecurrence(open.recurrence);
  if (!rule || !canRepeatPlan(rule))
    throw new ApiError(
      "validation_failed",
      rule
        ? `Todo ${open.id} repeats counted from the day it is done, so its dates are not known ahead. Plan time for this one only.`
        : `Todo ${open.id} does not repeat. Plan time for it as a single block.`,
    );
  const anchor = open.anchor ?? startsOn;
  const base = scheduleRule(rule, anchor);
  // The todo's date on or before the planned one (or the todo's own date, when planned before it).
  const own = startsOn < anchor ? anchor : previousRuleDate(base, anchor, addDays(startsOn, 1));
  const delta = daysBetween(own, startsOn);
  const shifted = shiftRule(base, delta);
  if (shifted === null)
    throw new ApiError(
      "validation_failed",
      `This repeat cannot move to another day. Plan the time on ${formatDate(own)}, the todo's day.`,
    );
  return { rule: scheduleRule(shifted, startsOn), endsOn: rule.until ?? null };
}

/** Plans time for a repeating todo that comes back with every date of its repeat. */
export function createRepeatPlan(ctx: Ctx, todoId: number, input: CreateBlockSeries): BlockSeries {
  return ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    const chain = chainOf(sc, todoId);
    if (ownerOf(sc, chain) !== null)
      throw new ApiError(
        "conflict",
        `Todo ${todoId} has planned time that repeats already. Change or remove it in the planner.`,
      );
    const open = chain.at(-1) as Member;
    if (open.status === "done")
      throw new ApiError(
        "validation_failed",
        `The repeat of todo ${todoId} has ended. Plan time for it as a single block.`,
      );
    const startsOn = toLocalDate(input.startAt, ctx.timeZone);
    const { rule, endsOn } = planRule(open, startsOn);
    const span = {
      rule,
      startsOn,
      endsOn: endsOn !== null && endsOn < startsOn ? startsOn : endsOn,
      startTime: toLocalTime(input.startAt, ctx.timeZone),
      durationMinutes: Math.round((Date.parse(input.endAt) - Date.parse(input.startAt)) / 60_000),
    };
    checkHasDates(span);
    const owner: SeriesOwner = { kind: "todo", id: open.id };
    insertSegment(sc, owner, span, now(ctx), TEXTS);
    return getRepeatPlan(ctx, open.id, sc);
  });
}

/** Moves or cancels one planned date, or this and following, or all of its part. */
export function changeRepeatPlanDate(
  ctx: Ctx,
  todoId: number,
  on: string,
  input: BlockDateChange,
): BlockSeries {
  return ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    const ownerId = ownerOf(sc, chainOf(sc, todoId));
    if (ownerId === null) throw noPlan(todoId);
    const loaded = loadSeries(sc, { kind: "todo", id: ownerId }, on, TEXTS);
    changeDate(sc, loaded, on, input, ctx.timeZone, now(ctx));
    const plan = planOfChain(ctx, sc, chainOf(sc, ownerId));
    // Cancelling every later date can leave nothing; then the planned time is gone.
    if (!plan) throw noPlan(todoId);
    return plan;
  });
}

/** Removes the planned time with all its dates, past ones too. The todos stay. */
export function deleteRepeatPlan(ctx: Ctx, todoId: number): void {
  ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    const chain = chainOf(sc, todoId);
    const ownerId = ownerOf(sc, chain);
    if (ownerId === null) throw noPlan(todoId);
    sc.db
      .delete(series)
      .where(owned(sc, series, and(eq(series.ownerKind, "todo"), eq(series.todoId, ownerId))))
      .run();
  });
}

/** The planned dates of every repeating todo (or of one) that overlap the days from..to, by start. */
export function listRepeatOccurrences(ctx: Ctx, query: BlockOccurrenceQuery): BlockOccurrence[] {
  const chains =
    query.todoId === undefined ? allChains(ctx).filter((c) => c.length > 0) : [chainOf(ctx, query.todoId)];
  const segments = segmentsOfOwners(
    ctx,
    "todo",
    chains.flatMap((c) => c.map((m) => m.id)),
  );
  const owners = chains.flatMap((chain) => {
    const owner = chain.find((m) => (segments.get(m.id)?.length ?? 0) > 0);
    return owner ? [{ owner, chain }] : [];
  });
  const exceptions = exceptionsOf(
    ctx,
    owners.flatMap(({ owner }) => (segments.get(owner.id) ?? []).map((s) => s.id)),
  );
  const projects = projectRefs(
    ctx,
    owners.flatMap(({ chain }) => chain.map((m) => m.projectId)),
  );
  const out: BlockOccurrence[] = [];
  for (const { owner, chain } of owners) {
    for (const o of expandSeries(
      segments.get(owner.id) ?? [],
      exceptions,
      query.from,
      query.to,
      ctx.timeZone,
    )) {
      if (o.status === "cancelled" && query.cancelled !== true) continue;
      out.push(toOccurrence(o, owner.id, chain, projects));
    }
  }
  return out.toSorted((a, b) => a.startAt.localeCompare(b.startAt) || a.ownerTodoId - b.ownerTodoId);
}

/**
 * Every repeating todo once: the newest todo of each repeat that still has a rule, with when it comes
 * next, how often it was done and its planned time. Open ones first by date, then the ended ones.
 */
export function listRecurring(ctx: Ctx): RecurringTodo[] {
  const chains = allChains(ctx).filter((chain) => {
    const open = chain.at(-1) as Member;
    return parseRecurrence(open.recurrence) !== null;
  });
  const heads = chains.map((c) => c.at(-1) as Member).slice(0, MAX_RECURRING);
  const rows =
    heads.length === 0
      ? []
      : chunks(heads.map((h) => h.id)).flatMap((part) =>
          ctx.db
            .select()
            .from(todos)
            .where(owned(ctx, todos, inArray(todos.id, part)))
            .all(),
        );
  const todosById = new Map(hydrate(ctx, rows).map((t) => [t.id, t]));
  const plans = plansOf(ctx, ctx, chains);
  const out: RecurringTodo[] = [];
  for (const chain of chains) {
    const open = chain.at(-1) as Member;
    const todo = todosById.get(open.id);
    const rule = parseRecurrence(open.recurrence);
    if (!todo || !rule) continue;
    const done = chain.filter((m) => m.status === "done");
    const lastDoneAt = done.reduce<string | null>(
      (latest, m) => (m.doneAt !== null && (latest === null || m.doneAt > latest) ? m.doneAt : latest),
      null,
    );
    const ended = open.status === "done";
    const plan = chain.map((m) => plans.get(m.id)).find((p) => p !== undefined) ?? null;
    out.push({
      todo,
      text: describeRecurrence(rule),
      nextOn: ended ? null : open.anchor,
      ended,
      doneCount: done.length,
      lastDoneAt,
      plan,
    });
  }
  return out.toSorted((a, b) => {
    if (a.ended !== b.ended) return a.ended ? 1 : -1;
    const byDate = (a.nextOn ?? "9999").localeCompare(b.nextOn ?? "9999");
    return byDate || a.todo.title.localeCompare(b.todo.title) || a.todo.id - b.todo.id;
  });
}
