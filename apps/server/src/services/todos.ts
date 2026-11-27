import {
  ACTIVE_STATUSES,
  applyLabelChange,
  buildNextUp,
  countChecklist,
  type CreateTodo,
  type NextQuery,
  type NextUp,
  type PersonBrief,
  type PersonRef,
  type PersonRole,
  RecurrenceRule,
  sortLabels,
  startOfLocalDay,
  nextOccurrence,
  normalizeRecurrence,
  recurrenceProblem,
  type RecurrenceRuleInput,
  resetChecklist,
  shiftTodoDates,
  type Todo,
  type TodoListQuery,
  type TodoRef,
  toLocalDate,
  type TodoPage,
  todoDurationMs,
  type UpdateTodo,
} from "@organizer/shared";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, type SQL, sql } from "drizzle-orm";
import { insertUrls, urlsByTodo } from "./urls.ts";
import { accounts } from "../db/auth-schema.ts";
import { assigneesById, assigneeSummary, isAssignable, resolveAssignee } from "./assignees.ts";
import { type Acting, notifyTodoChange } from "./notifications.ts";
import { comments, events, labels, people, todoLabels, todoLinks, todoPeople, todos } from "../db/schema.ts";
import { ApiError, notFound } from "../http/errors.ts";
import { type Ctx, inTx, now, type Scoped } from "./context.ts";
import { endRepeatPlan, moveRepeatPlan } from "./repeat-plan-owner.ts";
import { insertOwnedRow, owned } from "./owned.ts";
import { type EventInput, recordEvents } from "./events.ts";
import { assertCanBeParent, nextChildPosition } from "./hierarchy.ts";
import { resolveLabels, toLabel } from "./labels.ts";
import { linksByTodo } from "./links.ts";
import { assertProjectExists, projectRefs } from "./projects.ts";
import { resolvePeople, toPersonBrief } from "./people.ts";
import { indexTodo, removeTodoFromIndex } from "./search-index.ts";
import { chunks, containsFolded, diffIds, type SetChange } from "./sql.ts";
import { foldCase } from "./text.ts";

export type TodoRow = typeof todos.$inferSelect;

/** Turns todo rows into API todos with labels, people of both roles, comment count and project. */
export function hydrate(sc: Scoped, rows: readonly TodoRow[]): Todo[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const labelsByTodo = new Map<number, ReturnType<typeof toLabel>[]>();
  const requestersByTodo = new Map<number, PersonBrief[]>();
  const contactsByTodo = new Map<number, PersonBrief[]>();
  const commentCounts = new Map<number, number>();
  for (const part of chunks(ids)) {
    const labelRows = sc.db
      .select({ todoId: todoLabels.todoId, label: labels })
      .from(todoLabels)
      .innerJoin(labels, and(eq(labels.accountId, todoLabels.accountId), eq(labels.id, todoLabels.labelId)))
      .where(owned(sc, todoLabels, inArray(todoLabels.todoId, part)))
      .all();
    for (const { todoId, label } of labelRows) {
      const list = labelsByTodo.get(todoId) ?? [];
      list.push(toLabel(label));
      labelsByTodo.set(todoId, list);
    }
    const personRows = sc.db
      .select({ todoId: todoPeople.todoId, role: todoPeople.role, person: people })
      .from(todoPeople)
      .innerJoin(people, and(eq(people.accountId, todoPeople.accountId), eq(people.id, todoPeople.personId)))
      .where(owned(sc, todoPeople, inArray(todoPeople.todoId, part)))
      .orderBy(asc(todoPeople.createdAt), asc(people.id))
      .all();
    for (const { todoId, role, person } of personRows) {
      const byTodo = role === "contact" ? contactsByTodo : requestersByTodo;
      const list = byTodo.get(todoId) ?? [];
      list.push(toPersonBrief(person));
      byTodo.set(todoId, list);
    }
    for (const { todoId, n } of sc.db
      .select({ todoId: comments.todoId, n: count() })
      .from(comments)
      .where(owned(sc, comments, inArray(comments.todoId, part)))
      .groupBy(comments.todoId)
      .all()) {
      commentCounts.set(todoId, n);
    }
  }
  const projectById = projectRefs(
    sc,
    rows.map((r) => r.projectId),
  );
  const relations = todoRelations(sc, rows);
  const urls = urlsByTodo(sc, ids);
  const assignees = assigneesById(
    sc.db,
    rows.map((r) => r.assigneeId),
  );
  return rows.map((row) => ({
    id: row.id,
    projectId: row.projectId,
    parentId: row.parentId,
    title: row.title,
    descriptionMd: row.descriptionMd,
    status: row.status,
    dueOn: row.dueOn,
    plannedOn: row.plannedOn,
    position: row.position,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    doneAt: row.doneAt,
    lastActivityAt: row.lastActivityAt,
    durationMs: row.status === "done" ? todoDurationMs(row.createdAt, row.doneAt) : null,
    labels: sortLabels(labelsByTodo.get(row.id) ?? []),
    requestedBy: requestersByTodo.get(row.id) ?? [],
    contacts: contactsByTodo.get(row.id) ?? [],
    commentCount: commentCounts.get(row.id) ?? 0,
    project: row.projectId === null ? null : (projectById.get(row.projectId) ?? null),
    parent: row.parentId === null ? null : (relations.refs.get(row.parentId) ?? null),
    progress: {
      subtasks: relations.children.get(row.id) ?? { total: 0, done: 0 },
      checklist: countChecklist(row.descriptionMd),
    },
    links: relations.links.get(row.id) ?? { blocks: [], blockedBy: [], relatesTo: [] },
    urls: urls.get(row.id) ?? [],
    recurrence: parseRecurrence(row.recurrence),
    previousOccurrenceId: row.recurrencePrevId,
    nextOccurrence: relations.next.get(row.id) ?? null,
    assignee: row.assigneeId === null ? null : (assignees.get(row.assigneeId) ?? null),
    actionNeeded:
      row.actionNeeded === null
        ? null
        : { reason: row.actionNeeded, by: row.actionNeededBy ?? "", at: row.actionNeededAt ?? row.updatedAt },
  }));
}

/** The stored rule, or null (also for a value that no longer parses). */
export function parseRecurrence(json: string | null): RecurrenceRule | null {
  if (json === null) return null;
  const parsed = RecurrenceRule.safeParse(JSON.parse(json));
  return parsed.success ? parsed.data : null;
}

/** Parents, child counts, links and next occurrences of the given todos, one grouped query each per chunk. */
function todoRelations(sc: Scoped, rows: readonly TodoRow[]) {
  const ids = rows.map((r) => r.id);
  const refs = new Map<number, TodoRef>();
  const children = new Map<number, { total: number; done: number }>();
  const next = new Map<number, TodoRef>();
  const parentIds = [...new Set(rows.map((r) => r.parentId).filter((id) => id !== null))];
  for (const part of chunks(parentIds)) {
    for (const t of sc.db
      .select({ id: todos.id, title: todos.title, status: todos.status })
      .from(todos)
      .where(owned(sc, todos, inArray(todos.id, part)))
      .all())
      refs.set(t.id, t);
  }
  for (const part of chunks(ids)) {
    for (const c of sc.db
      .select({
        parentId: todos.parentId,
        total: count(),
        done: sql<number>`sum(${todos.status} = 'done')`,
      })
      .from(todos)
      .where(owned(sc, todos, inArray(todos.parentId, part)))
      .groupBy(todos.parentId)
      .all()) {
      if (c.parentId !== null) children.set(c.parentId, { total: c.total, done: Number(c.done) });
    }
    for (const t of sc.db
      .select({ id: todos.id, title: todos.title, status: todos.status, prev: todos.recurrencePrevId })
      .from(todos)
      .where(owned(sc, todos, inArray(todos.recurrencePrevId, part)))
      .all()) {
      if (t.prev !== null) next.set(t.prev, { id: t.id, title: t.title, status: t.status });
    }
  }
  return { refs, children, next, links: linksByTodo(sc, ids) };
}

export function getTodo(sc: Scoped, id: number): Todo {
  const row = sc.db
    .select()
    .from(todos)
    .where(owned(sc, todos, eq(todos.id, id)))
    .get();
  if (!row) throw notFound("Todo", id);
  return hydrate(sc, [row])[0] as Todo;
}

interface PersonSummary {
  id: number;
  name: string;
}
const personSummary = (p: { id: number; displayName: string }): PersonSummary => ({
  id: p.id,
  name: p.displayName,
});

/** Fields a new todo can get beyond CreateTodo (subtasks, repeats). */
export interface NewTodoExtra {
  parentId?: number | null;
  position?: number;
  recurrence?: string | null;
  recurrencePrevId?: number | null;
  /** An assignee already checked (a repeat's next todo keeps it); input.assignee is checked here. */
  assigneeId?: number | null;
}

/**
 * Inserts a todo with labels, people, search row and the created event, inside a transaction.
 * Callers check the parent and project first.
 */
export function insertTodo(
  sc: Scoped,
  at: string,
  actor: string,
  input: CreateTodo,
  extra: NewTodoExtra = {},
): Todo {
  assertProjectExists(sc, input.projectId);
  const labelRows = resolveLabels(sc, input.labels ?? []);
  const labelIds = [...new Set(labelRows.map((l) => l.id))];
  const linked = [
    ...resolvePeople(sc, at, input.requestedBy ?? [], true).map((p) => ({ p, role: "requester" as const })),
    ...resolvePeople(sc, at, input.contacts ?? [], true).map((p) => ({ p, role: "contact" as const })),
  ];
  const status = input.status ?? "open";
  const assigneeId =
    extra.assigneeId !== undefined ? extra.assigneeId : resolveAssignee(sc, input.assignee ?? null);
  const id = insertOwnedRow(sc, todos, {
    title: input.title,
    descriptionMd: input.descriptionMd ?? "",
    status,
    projectId: input.projectId ?? null,
    parentId: extra.parentId ?? null,
    dueOn: input.dueOn ?? null,
    plannedOn: input.plannedOn ?? null,
    position: extra.position ?? 0,
    createdAt: at,
    updatedAt: at,
    doneAt: status === "done" ? at : null,
    lastActivityAt: at,
    recurrence: extra.recurrence ?? null,
    recurrencePrevId: extra.recurrencePrevId ?? null,
    assigneeId,
    ...(input.actionNeeded !== undefined &&
      input.actionNeeded !== null && {
        actionNeeded: input.actionNeeded,
        actionNeededBy: actor,
        actionNeededAt: at,
      }),
  });
  const row = todoRow(sc, id);
  const accountId = sc.accountId;
  if (labelIds.length > 0)
    sc.db
      .insert(todoLabels)
      .values(labelIds.map((labelId) => ({ accountId, todoId: id, labelId })))
      .run();
  if (linked.length > 0) {
    sc.db
      .insert(todoPeople)
      .values(linked.map(({ p, role }) => ({ accountId, todoId: id, personId: p.id, role, createdAt: at })))
      .run();
  }
  insertUrls(sc, at, id, input.urls ?? []);
  indexTodo(sc, row.id);
  const todo = hydrate(sc, [row])[0] as Todo;
  recordEvents(sc, actor, at, [
    {
      todoId: row.id,
      kind: "created",
      data: {
        to: {
          title: todo.title,
          status: todo.status,
          projectId: todo.projectId,
          dueOn: todo.dueOn,
          plannedOn: todo.plannedOn,
          labels: todo.labels.map((l) => l.name),
          requestedBy: todo.requestedBy.map(personSummary),
          contacts: todo.contacts.map(personSummary),
          ...(row.parentId === null ? {} : { parentId: row.parentId }),
          ...(row.recurrencePrevId === null ? {} : { previousOccurrenceId: row.recurrencePrevId }),
          ...(todo.assignee === null ? {} : { assignee: assigneeSummary(todo.assignee) }),
          ...(todo.actionNeeded === null ? {} : { actionNeeded: todo.actionNeeded.reason }),
        },
      },
    },
  ]);
  return todo;
}

/** Message when a repeat rule has no date to count from. */
const NEEDS_DATE = "A repeating todo needs a due date or a planned day.";

/** The rule as stored: normalized from the anchor (due date, else planned day). 422 without an anchor. */
function storedRule(
  rule: RecurrenceRuleInput,
  dueOn: string | null,
  plannedOn: string | null,
): RecurrenceRule {
  const anchor = dueOn ?? plannedOn;
  if (anchor === null) throw new ApiError("validation_failed", NEEDS_DATE);
  const problem = recurrenceProblem(rule, anchor);
  if (problem) throw new ApiError("validation_failed", problem);
  return normalizeRecurrence(rule, anchor);
}

const todoSummary = (t: { id: number; title: string }) => ({ id: t.id, title: t.title });

function todoRow(sc: Scoped, id: number): TodoRow {
  const row = sc.db
    .select()
    .from(todos)
    .where(owned(sc, todos, eq(todos.id, id)))
    .get();
  if (!row) throw notFound("Todo", id);
  return row;
}

/**
 * Deletes one todo row and its search rows. Its comments, links, labels, people and history go with it
 * (cascade); its subtasks and its next occurrence lose the reference first (those are NO ACTION, see
 * db/schema.ts). The caller records the events.
 */
function deleteTodoRow(sc: Scoped, id: number): void {
  sc.db
    .update(todos)
    .set({ parentId: null })
    .where(owned(sc, todos, eq(todos.parentId, id)))
    .run();
  sc.db
    .update(todos)
    .set({ recurrencePrevId: null })
    .where(owned(sc, todos, eq(todos.recurrencePrevId, id)))
    .run();
  sc.db
    .delete(todos)
    .where(owned(sc, todos, eq(todos.id, id)))
    .run();
  removeTodoFromIndex(sc, id);
}

export function touchTodos(sc: Scoped, at: string, ids: readonly number[]): void {
  if (ids.length > 0)
    sc.db
      .update(todos)
      .set({ updatedAt: at, lastActivityAt: at })
      .where(owned(sc, todos, inArray(todos.id, [...ids])))
      .run();
}

/**
 * Creates a todo. With parentId it becomes the last subtask (the parent records subtasks_changed)
 * and takes the parent's project unless projectId is given. A repeat rule needs a date.
 */
export function createTodo(ctx: Ctx, actor: string, input: CreateTodo): Todo {
  return ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    const at = now(ctx);
    const rule = input.recurrence
      ? storedRule(input.recurrence, input.dueOn ?? null, input.plannedOn ?? null)
      : null;
    const extra: NewTodoExtra = { recurrence: rule === null ? null : JSON.stringify(rule) };
    let projectId = input.projectId;
    if (input.parentId !== undefined) {
      assertCanBeParent(sc, null, input.parentId);
      if (projectId === undefined) projectId = todoRow(sc, input.parentId).projectId;
      extra.parentId = input.parentId;
      extra.position = nextChildPosition(sc, input.parentId);
    }
    // A new todo of a shared project with a planned day and nobody named is the planner's.
    const planner =
      input.plannedOn && input.assignee === undefined && input.status !== "done"
        ? plannerAssignee(sc, ctx.callerId, null)
        : undefined;
    const todo = insertTodo(
      sc,
      at,
      actor,
      { ...input, projectId, ...(planner !== undefined && { assignee: planner }) },
      extra,
    );
    if (input.parentId !== undefined) {
      touchTodos(sc, at, [input.parentId]);
      recordEvents(sc, actor, at, [
        {
          todoId: input.parentId,
          kind: "subtasks_changed",
          data: { added: [todoSummary(todo)], removed: [] },
        },
      ]);
    }
    notifyTodoChange(sc, ctx, actor, at, null, todo);
    return todo;
  });
}

/**
 * When a repeating todo is done and has no next occurrence yet: creates the next one with the same
 * title, description (checklist unchecked), project, labels and people, dates moved to the next
 * date. Missed dates are skipped; after `until` nothing is created. Children, comments and links
 * are not copied. The done todo records recurred.
 */
function createNextOccurrence(sc: Scoped, at: string, actor: string, id: number, timeZone: string): void {
  const todo = getTodo(sc, id);
  const anchor = todo.dueOn ?? todo.plannedOn;
  if (todo.recurrence === null || anchor === null || todo.nextOccurrence !== null) return;
  const today = toLocalDate(at, timeZone);
  const date = nextOccurrence(todo.recurrence, { anchor, doneOn: today, today });
  if (date === null) {
    // Past the last date: no next todo, and the planned time ends too.
    endRepeatPlan(sc, todo.id, today, at);
    return;
  }
  const dates = shiftTodoDates(todo, date);
  const next = insertTodo(
    sc,
    at,
    actor,
    {
      title: todo.title,
      descriptionMd: resetChecklist(todo.descriptionMd),
      projectId: todo.projectId,
      dueOn: dates.dueOn,
      plannedOn: dates.plannedOn,
      labels: todo.labels.map((l) => l.name),
      requestedBy: todo.requestedBy.map((p) => ({ personId: p.id })),
      contacts: todo.contacts.map((p) => ({ personId: p.id })),
      urls: todo.urls.map((u) => ({ url: u.url, label: u.label })),
    },
    {
      recurrence: JSON.stringify(todo.recurrence),
      recurrencePrevId: todo.id,
      // The next one stays with the same member while they are still in the project.
      assigneeId:
        todo.assignee !== null && isAssignable(sc.db, sc.accountId, todo.assignee.accountId)
          ? todo.assignee.accountId
          : null,
    },
  );
  moveRepeatPlan(sc, todo.id, next.id, at);
  recordEvents(sc, actor, at, [
    {
      todoId: todo.id,
      kind: "recurred",
      data: { next: { id: next.id, title: next.title, dueOn: next.dueOn, plannedOn: next.plannedOn } },
    },
  ]);
}

/**
 * Undo of "done" on a repeating todo: its next occurrence goes away when nobody touched it yet
 * (never changed, still open, no comments, subtasks or links); otherwise it stays.
 */
function removeUntouchedNext(sc: Scoped, at: string, id: number): void {
  const next = sc.db
    .select()
    .from(todos)
    .where(owned(sc, todos, eq(todos.recurrencePrevId, id)))
    .get();
  if (!next || next.updatedAt !== next.createdAt || next.status !== "open") return;
  const used = sc.db.get<{ n: number }>(sql`
    SELECT (SELECT count(*) FROM ${comments} WHERE account_id = ${sc.accountId} AND todo_id = ${next.id})
         + (SELECT count(*) FROM ${todos} WHERE account_id = ${sc.accountId} AND parent_id = ${next.id})
         + (SELECT count(*) FROM ${todoLinks}
            WHERE account_id = ${sc.accountId} AND (from_id = ${next.id} OR to_id = ${next.id})) AS n`);
  if (used.n > 0) return;
  moveRepeatPlan(sc, next.id, id, at);
  deleteTodoRow(sc, next.id);
}

const normNames = (list: readonly string[]): string => list.map(foldCase).toSorted().join("\n");
const sameNames = (a: readonly string[], b: readonly string[]): boolean => normNames(a) === normNames(b);

/** Description edits by one actor within this time merge into one history entry (autosave). */
export const DESCRIPTION_MERGE_MS = 10 * 60_000;

/**
 * Merges a description edit into the todo's last event when that is a description_changed by the
 * same actor less than 10 minutes ago: it keeps its `from`, takes the new `to` and time, and goes
 * away when the text is back to where it started. Returns false when a new event is needed.
 */
function coalesceDescription(sc: Scoped, at: string, actor: string, todoId: number, to: string): boolean {
  const last = sc.db
    .select()
    .from(events)
    .where(owned(sc, events, eq(events.todoId, todoId)))
    .orderBy(desc(events.id))
    .limit(1)
    .get();
  if (
    !last ||
    last.kind !== "description_changed" ||
    last.actor !== actor ||
    Date.parse(at) - Date.parse(last.createdAt) > DESCRIPTION_MERGE_MS
  ) {
    return false;
  }
  const { from } = JSON.parse(last.data) as { from: string };
  if (from === to)
    sc.db
      .delete(events)
      .where(owned(sc, events, eq(events.id, last.id)))
      .run();
  else
    sc.db
      .update(events)
      .set({ data: JSON.stringify({ from, to }), createdAt: at })
      .where(owned(sc, events, eq(events.id, last.id)))
      .run();
  return true;
}

const ROLE_FIELD = { requester: "requestedBy", contact: "contacts" } as const;

/**
 * Changes the people of one role on a todo (full set, or add/remove). By name: find-or-create for
 * set and add; remove never creates. Returns the people_changed event data, or null when the set
 * stays the same.
 */
function applyPeopleChange(
  sc: Scoped,
  at: string,
  current: Todo,
  role: PersonRole,
  change: SetChange<PersonRef>,
): { role: PersonRole; from: PersonSummary[]; to: PersonSummary[] } | null {
  if (change.set === undefined && change.add === undefined && change.remove === undefined) return null;
  const before = current[ROLE_FIELD[role]];
  const ids = (refs: readonly PersonRef[] | undefined, create: boolean) =>
    refs === undefined ? undefined : resolvePeople(sc, at, refs, create).map((p) => p.id);
  const { next, added, removed } = diffIds(
    before.map((p) => p.id),
    { set: ids(change.set, true), add: ids(change.add, true), remove: ids(change.remove, false) },
  );
  if (added.length === 0 && removed.length === 0) return null;
  if (removed.length > 0) {
    sc.db
      .delete(todoPeople)
      .where(
        owned(
          sc,
          todoPeople,
          eq(todoPeople.todoId, current.id),
          eq(todoPeople.role, role),
          inArray(todoPeople.personId, removed),
        ),
      )
      .run();
  }
  if (added.length > 0) {
    sc.db
      .insert(todoPeople)
      .values(
        added.map((personId) => ({
          accountId: sc.accountId,
          todoId: current.id,
          personId,
          role,
          createdAt: at,
        })),
      )
      .run();
  }
  const byId = new Map(
    sc.db
      .select()
      .from(people)
      .where(owned(sc, people, inArray(people.id, next.length > 0 ? next : [-1])))
      .all()
      .map((p) => [p.id, personSummary(toPersonBrief(p))]),
  );
  return {
    role,
    from: before.map(personSummary),
    to: next.map((id) => byId.get(id)).filter((p) => p !== undefined),
  };
}

/**
 * Applies one change to a todo inside a transaction: server rules for done_at, last_activity_at,
 * scoped label exclusivity and requesters, plus one event per kind of change. Position alone is
 * reordering, not activity: it bumps updated_at only and records no event.
 */
function applyChange(
  sc: Scoped,
  at: string,
  actor: string,
  current: Todo,
  change: UpdateTodo,
  timeZone: string,
): void {
  const set: Partial<TodoRow> = {};
  const evts: EventInput[] = [];
  const event = (kind: EventInput["kind"], data: unknown) => evts.push({ todoId: current.id, kind, data });
  /** Other todos that get an event and an activity bump (old and new parent). */
  const others: EventInput[] = [];

  if (change.title !== undefined && change.title !== current.title) {
    set.title = change.title;
    event("title_changed", { from: current.title, to: change.title });
  }
  if (change.descriptionMd !== undefined && change.descriptionMd !== current.descriptionMd) {
    set.descriptionMd = change.descriptionMd;
    if (!coalesceDescription(sc, at, actor, current.id, change.descriptionMd)) {
      event("description_changed", { from: current.descriptionMd, to: change.descriptionMd });
    }
  }
  if (change.status !== undefined && change.status !== current.status) {
    set.status = change.status;
    if (change.status === "done") set.doneAt = at;
    else if (current.status === "done") set.doneAt = null;
    event("status_changed", { from: current.status, to: change.status });
  }
  if (change.projectId !== undefined && change.projectId !== current.projectId) {
    assertProjectExists(sc, change.projectId);
    set.projectId = change.projectId;
    event("project_changed", { from: current.projectId, to: change.projectId });
  }
  const dueOn = change.dueOn === undefined ? current.dueOn : change.dueOn;
  const plannedOn = change.plannedOn === undefined ? current.plannedOn : change.plannedOn;
  if (dueOn !== current.dueOn || plannedOn !== current.plannedOn) {
    set.dueOn = dueOn;
    set.plannedOn = plannedOn;
    event("dates_changed", {
      from: { dueOn: current.dueOn, plannedOn: current.plannedOn },
      to: { dueOn, plannedOn },
    });
  }
  if (change.position !== undefined && change.position !== current.position) set.position = change.position;

  if (change.parentId !== undefined && change.parentId !== current.parentId) {
    if (change.parentId !== null) {
      assertCanBeParent(sc, current.id, change.parentId);
      if (change.position === undefined) set.position = nextChildPosition(sc, change.parentId);
    }
    set.parentId = change.parentId;
    const self = todoSummary(current);
    const ref = (id: number | null) => (id === null ? null : todoSummary(todoRow(sc, id)));
    event("parent_changed", { from: ref(current.parentId), to: ref(change.parentId) });
    if (current.parentId !== null) {
      others.push({
        todoId: current.parentId,
        kind: "subtasks_changed",
        data: { added: [], removed: [self] },
      });
    }
    if (change.parentId !== null) {
      others.push({
        todoId: change.parentId,
        kind: "subtasks_changed",
        data: { added: [self], removed: [] },
      });
    }
  }

  const datesChanged = dueOn !== current.dueOn || plannedOn !== current.plannedOn;
  const rule = change.recurrence === undefined ? current.recurrence : change.recurrence;
  if (change.recurrence !== undefined || (rule !== null && datesChanged)) {
    const stored =
      rule === null ? null : change.recurrence === undefined ? rule : storedRule(rule, dueOn, plannedOn);
    if (stored !== null && dueOn === null && plannedOn === null)
      throw new ApiError("validation_failed", NEEDS_DATE);
    if (JSON.stringify(stored) !== JSON.stringify(current.recurrence)) {
      set.recurrence = stored === null ? null : JSON.stringify(stored);
      event("recurrence_changed", { from: current.recurrence, to: stored });
      // Stopping the repeat (or counting it from done dates) ends its planned time; past dates stay.
      if (stored === null || stored.basis !== "schedule")
        endRepeatPlan(sc, current.id, toLocalDate(at, timeZone), at);
    }
  }

  if (change.labels !== undefined || change.addLabels !== undefined || change.removeLabels !== undefined) {
    const names = (list: readonly string[] | undefined) =>
      list === undefined ? undefined : resolveLabels(sc, list).map((l) => l.name);
    const currentNames = current.labels.map((l) => l.name);
    const next = applyLabelChange(currentNames, {
      set: names(change.labels),
      add: names(change.addLabels),
      remove: names(change.removeLabels),
    });
    if (!sameNames(currentNames, next)) {
      const nextIds = resolveLabels(sc, next).map((l) => l.id);
      sc.db
        .delete(todoLabels)
        .where(owned(sc, todoLabels, eq(todoLabels.todoId, current.id)))
        .run();
      if (nextIds.length > 0) {
        sc.db
          .insert(todoLabels)
          .values(nextIds.map((labelId) => ({ accountId: sc.accountId, todoId: current.id, labelId })))
          .run();
      }
      event("labels_changed", { from: currentNames, to: next });
    }
  }

  if (change.assignee !== undefined) {
    const assigneeId = resolveAssignee(sc, change.assignee);
    if (assigneeId !== (current.assignee?.accountId ?? null)) {
      set.assigneeId = assigneeId;
      const to = assigneeId === null ? null : (assigneesById(sc.db, [assigneeId]).get(assigneeId) ?? null);
      event("assignee_changed", { from: assigneeSummary(current.assignee), to: assigneeSummary(to) });
    }
  }

  if (change.actionNeeded !== undefined) {
    const from = current.actionNeeded?.reason ?? null;
    if (change.actionNeeded !== from) {
      set.actionNeeded = change.actionNeeded;
      set.actionNeededBy = change.actionNeeded === null ? null : actor;
      set.actionNeededAt = change.actionNeeded === null ? null : at;
      event("action_needed_changed", { from, to: change.actionNeeded });
    }
  }

  const requesters = applyPeopleChange(sc, at, current, "requester", {
    set: change.requestedBy,
    add: change.addRequestedBy,
    remove: change.removeRequestedBy,
  });
  if (requesters) event("people_changed", requesters);
  const contacts = applyPeopleChange(sc, at, current, "contact", {
    set: change.contacts,
    add: change.addContacts,
    remove: change.removeContacts,
  });
  if (contacts) event("people_changed", contacts);

  if (evts.length === 0 && Object.keys(set).length === 0) return;
  set.updatedAt = at;
  if (evts.length > 0 || set.descriptionMd !== undefined) set.lastActivityAt = at;
  sc.db
    .update(todos)
    .set(set)
    .where(owned(sc, todos, eq(todos.id, current.id)))
    .run();
  if (set.title !== undefined || set.descriptionMd !== undefined) indexTodo(sc, current.id);
  touchTodos(
    sc,
    at,
    others.map((e) => e.todoId),
  );
  recordEvents(sc, actor, at, [...evts, ...others]);
  if (set.status === "done") createNextOccurrence(sc, at, actor, current.id, timeZone);
  else if (set.status !== undefined && current.status === "done") removeUntouchedNext(sc, at, current.id);
}

/**
 * Planning assigns (S5#13): a todo of a shared project that gets a planned day or planned time while
 * nobody is on it goes to the member who planned it. The username to assign, or undefined: own todos,
 * done todos, a todo someone is on already (it stays theirs), and callers that are no member.
 */
function plannerAssignee(sc: Scoped, callerId: number | undefined, current: Todo | null): string | undefined {
  if (callerId === undefined || current?.assignee != null || current?.status === "done") return undefined;
  if (!isAssignable(sc.db, sc.accountId, callerId)) return undefined;
  return assigneesById(sc.db, [callerId]).get(callerId)?.username;
}

/** The change with the planner as assignee when it plans an unassigned todo of a shared project. */
function withPlanner(
  sc: Scoped,
  callerId: number | undefined,
  current: Todo,
  change: UpdateTodo,
): UpdateTodo {
  const plans =
    change.plannedOn !== undefined && change.plannedOn !== null && change.plannedOn !== current.plannedOn;
  if (!plans || change.assignee !== undefined || change.status === "done") return change;
  const assignee = plannerAssignee(sc, callerId, current);
  return assignee === undefined ? change : { ...change, assignee };
}

/**
 * Time planned for a shared project's todo gives the todo to whoever planned it, if nobody is on it
 * (with an assignee_changed line and the usual notification). Own todos are left alone.
 */
export function assignPlanner(
  sc: Scoped,
  acting: Acting,
  at: string,
  actor: string,
  id: number,
  timeZone: string,
): void {
  const current = getTodo(sc, id);
  const assignee = plannerAssignee(sc, acting.callerId, current);
  if (assignee === undefined) return;
  applyChange(sc, at, actor, current, { assignee }, timeZone);
  notifyTodoChange(sc, acting, actor, at, current, getTodo(sc, id));
}

/**
 * Time planned for a todo in the planner also plans the todo for that day (the Week view and the
 * planner's Day row read the planned day), recorded as a normal date change. Done todos stay as they are.
 */
export function planTodoOn(
  sc: Scoped,
  at: string,
  actor: string,
  id: number,
  day: string,
  timeZone: string,
): void {
  const current = getTodo(sc, id);
  if (current.status === "done" || current.plannedOn === day) return;
  applyChange(sc, at, actor, current, { plannedOn: day }, timeZone);
}

export function updateTodo(ctx: Ctx, actor: string, id: number, change: UpdateTodo): Todo {
  return ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    const at = now(ctx);
    const before = getTodo(sc, id);
    applyChange(sc, at, actor, before, withPlanner(sc, ctx.callerId, before, change), ctx.timeZone);
    const after = getTodo(sc, id);
    notifyTodoChange(sc, ctx, actor, at, before, after);
    return after;
  });
}

/** Applies one patch to many todos, all or nothing. */
export function bulkUpdate(ctx: Ctx, actor: string, ids: readonly number[], change: UpdateTodo): Todo[] {
  return ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    const rows = sc.db
      .select()
      .from(todos)
      .where(owned(sc, todos, inArray(todos.id, [...ids])))
      .all();
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new ApiError(
        "not_found",
        `Todo${missing.length > 1 ? "s" : ""} ${missing.map((id) => `#${id}`).join(", ")} ${missing.length > 1 ? "do" : "does"} not exist. Nothing was changed.`,
        {
          missingIds: missing,
        },
      );
    }
    const at = now(ctx);
    const byId = new Map(hydrate(sc, rows).map((t) => [t.id, t]));
    for (const id of ids) {
      const before = byId.get(id) as Todo;
      applyChange(sc, at, actor, before, withPlanner(sc, ctx.callerId, before, change), ctx.timeZone);
    }
    const after = new Map(
      hydrate(
        sc,
        sc.db
          .select()
          .from(todos)
          .where(owned(sc, todos, inArray(todos.id, [...ids])))
          .all(),
      ).map((t) => [t.id, t]),
    );
    for (const [id, todo] of after) notifyTodoChange(sc, ctx, actor, at, byId.get(id) ?? null, todo);
    return ids.map((id) => after.get(id) as Todo);
  });
}

/**
 * Deletes a todo with its comments, links and history (cascade), and its search rows. Its subtasks
 * become top-level todos (parent_changed each) and its parent records subtasks_changed.
 */
export function deleteTodo(ctx: Ctx, actor: string, id: number): void {
  ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    const row = sc.db
      .select()
      .from(todos)
      .where(owned(sc, todos, eq(todos.id, id)))
      .get();
    if (!row) throw notFound("Todo", id);
    const at = now(ctx);
    const children = sc.db
      .select({ id: todos.id })
      .from(todos)
      .where(owned(sc, todos, eq(todos.parentId, id)))
      .all();
    const self = { id: row.id, title: row.title };
    deleteTodoRow(sc, id);
    const touched = [...children.map((c) => c.id), ...(row.parentId === null ? [] : [row.parentId])];
    touchTodos(sc, at, touched);
    recordEvents(sc, actor, at, [
      ...children.map((c) => ({
        todoId: c.id,
        kind: "parent_changed" as const,
        data: { from: self, to: null },
      })),
      ...(row.parentId === null
        ? []
        : [
            { todoId: row.parentId, kind: "subtasks_changed" as const, data: { added: [], removed: [self] } },
          ]),
    ]);
  });
}

/**
 * Correlated subqueries name the outer table explicitly ("todos"."id"): drizzle leaves the table off
 * columns in some positions, and inside the subquery a bare "id" would mean the label's id.
 */

/** Importance for sorting: critical 4, high 3, medium 2, none 1, low 0. */
const priorityKey = sql`coalesce((
  SELECT CASE lower(l.value) WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 0 END
  FROM ${todoLabels} tl JOIN ${labels} l ON l.account_id = tl.account_id AND l.id = tl.label_id
  WHERE tl.account_id = "todos"."account_id" AND tl.todo_id = "todos"."id" AND lower(l.scope) = 'priority' AND lower(l.value) IN ('critical','high','medium','low')
  LIMIT 1
), 1)`;

/** The todo (outer table "todos") has the label with this name. */
export const hasLabel = (name: string): SQL =>
  sql`EXISTS (SELECT 1 FROM ${todoLabels} tl JOIN ${labels} l ON l.account_id = tl.account_id AND l.id = tl.label_id
    WHERE tl.account_id = "todos"."account_id" AND tl.todo_id = "todos"."id" AND l.name = ${name})`;

export function projectCondition(projectId: number | "inbox" | undefined): SQL | undefined {
  if (projectId === undefined) return undefined;
  return projectId === "inbox" ? isNull(todos.projectId) : eq(todos.projectId, projectId);
}

/**
 * The assignee filter: "me" is the caller's own account (callerId), "none" unassigned, else the
 * account with that username. Unknown names and a missing caller match nothing.
 */
export function assigneeCondition(
  sc: Pick<Scoped, "db"> & { callerId?: number },
  filter: TodoListQuery["assignee"],
): SQL | undefined {
  if (filter === undefined) return undefined;
  if (filter === "none") return isNull(todos.assigneeId);
  const id =
    filter === "me"
      ? sc.callerId
      : sc.db.select({ id: accounts.id }).from(accounts).where(eq(accounts.username, filter)).get()?.id;
  return id === undefined ? sql`0` : eq(todos.assigneeId, id);
}

function listConditions(sc: Scoped & { callerId?: number }, query: TodoListQuery, timeZone: string): SQL {
  const conditions: (SQL | undefined)[] = [assigneeCondition(sc, query.assignee)];
  if (query.status !== "all") conditions.push(inArray(todos.status, query.status));
  conditions.push(projectCondition(query.projectId));
  for (const name of query.label ?? []) conditions.push(hasLabel(name));
  if (query.personId !== undefined) {
    const role = query.personRole === "any" ? sql`` : sql` AND tp.role = ${query.personRole}`;
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${todoPeople} tp WHERE tp.account_id = "todos"."account_id"
        AND tp.todo_id = "todos"."id" AND tp.person_id = ${query.personId}${role})`,
    );
  }
  if (query.parentId === "none") conditions.push(isNull(todos.parentId));
  else if (query.parentId !== undefined) conditions.push(eq(todos.parentId, query.parentId));
  if (query.q) conditions.push(containsFolded(todos.title, query.q));
  if (query.dueBefore !== undefined) conditions.push(sql`${todos.dueOn} < ${query.dueBefore}`);
  if (query.plannedOn !== undefined) conditions.push(eq(todos.plannedOn, query.plannedOn));
  if (query.plannedFrom !== undefined) conditions.push(sql`${todos.plannedOn} >= ${query.plannedFrom}`);
  if (query.plannedTo !== undefined) conditions.push(sql`${todos.plannedOn} <= ${query.plannedTo}`);
  if (query.unplanned === true) conditions.push(isNull(todos.plannedOn));
  if (query.unplanned === false) conditions.push(isNotNull(todos.plannedOn));
  if (query.actionNeeded === true) conditions.push(isNotNull(todos.actionNeeded));
  if (query.actionNeeded === false) conditions.push(isNull(todos.actionNeeded));
  if (query.doneAfter !== undefined) {
    const start = startOfLocalDay(query.doneAfter, timeZone).toISOString();
    conditions.push(sql`(${todos.status} <> 'done' OR ${todos.doneAt} >= ${start})`);
  }
  return owned(sc, todos, ...conditions);
}

/**
 * Filtered, sorted page of todos. sort=due puts todos without a due date last in both orders;
 * sort=priority with order=desc lists critical first.
 */
export function listTodos(
  ctx: Pick<Ctx, "db" | "timeZone" | "accountId" | "callerId">,
  query: TodoListQuery,
): TodoPage {
  const where = listConditions(ctx, query, ctx.timeZone);
  const dir = query.order === "asc" ? asc : desc;
  const orderBy: SQL[] = [];
  switch (query.sort) {
    case "created":
      orderBy.push(dir(todos.createdAt));
      break;
    case "updated":
      orderBy.push(dir(todos.updatedAt));
      break;
    case "due":
      orderBy.push(sql`${todos.dueOn} IS NULL`, dir(todos.dueOn));
      break;
    case "priority":
      orderBy.push(dir(priorityKey));
      break;
    case "position":
      orderBy.push(dir(todos.position));
      break;
  }
  orderBy.push(dir(todos.id));
  const rows = ctx.db
    .select()
    .from(todos)
    .where(where)
    .orderBy(...orderBy)
    .limit(query.limit)
    .offset(query.offset)
    .all();
  const { n } = ctx.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM ${todos} WHERE ${where}`);
  return { items: hydrate(ctx, rows), total: n, limit: query.limit, offset: query.offset };
}

/** Next up: active todos ranked by the shared scoring, with today in the user's time zone. */
export function nextUp(ctx: Ctx, query: NextQuery): NextUp {
  const conditions: (SQL | undefined)[] = [
    inArray(todos.status, [...ACTIVE_STATUSES]),
    projectCondition(query.projectId),
    assigneeCondition(ctx, query.assignee),
  ];
  for (const name of query.label ?? []) conditions.push(hasLabel(name));
  const rows = ctx.db
    .select()
    .from(todos)
    .where(owned(ctx, todos, ...conditions))
    .all();
  return buildNextUp(hydrate(ctx, rows), {
    mode: query.mode,
    now: ctx.clock(),
    timeZone: ctx.timeZone,
    limit: query.limit,
  });
}
