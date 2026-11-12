import {
  ACTIVE_STATUSES,
  applyLabelChange,
  buildNextUp,
  type CreateTodo,
  type NextQuery,
  type NextUp,
  type PersonBrief,
  type PersonRef,
  type PersonRole,
  sortLabels,
  startOfLocalDay,
  type Todo,
  type TodoListQuery,
  type TodoPage,
  todoDurationMs,
  type UpdateTodo,
} from "@organizer/shared";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, type SQL, sql } from "drizzle-orm";
import { comments, events, labels, people, todoLabels, todoPeople, todos } from "../db/schema.ts";
import { ApiError, notFound } from "../http/errors.ts";
import { type Ctx, now, type Tx } from "./context.ts";
import { type EventInput, recordEvents } from "./events.ts";
import { resolveLabels, toLabel } from "./labels.ts";
import { assertProjectExists, projectRefs } from "./projects.ts";
import { resolvePeople, toPersonBrief } from "./people.ts";
import { indexTodo, removeTodoFromIndex } from "./search-index.ts";
import { chunks, diffIds, escapeLike, type SetChange } from "./sql.ts";

export type TodoRow = typeof todos.$inferSelect;

/** Turns todo rows into API todos with labels, people of both roles, comment count and project. */
export function hydrate(db: Tx, rows: readonly TodoRow[]): Todo[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const labelsByTodo = new Map<number, ReturnType<typeof toLabel>[]>();
  const requestersByTodo = new Map<number, PersonBrief[]>();
  const contactsByTodo = new Map<number, PersonBrief[]>();
  const commentCounts = new Map<number, number>();
  for (const part of chunks(ids)) {
    const labelRows = db
      .select({ todoId: todoLabels.todoId, label: labels })
      .from(todoLabels)
      .innerJoin(labels, eq(labels.id, todoLabels.labelId))
      .where(inArray(todoLabels.todoId, part))
      .all();
    for (const { todoId, label } of labelRows) {
      const list = labelsByTodo.get(todoId) ?? [];
      list.push(toLabel(label));
      labelsByTodo.set(todoId, list);
    }
    const personRows = db
      .select({ todoId: todoPeople.todoId, role: todoPeople.role, person: people })
      .from(todoPeople)
      .innerJoin(people, eq(people.id, todoPeople.personId))
      .where(inArray(todoPeople.todoId, part))
      .orderBy(asc(todoPeople.createdAt), asc(people.id))
      .all();
    for (const { todoId, role, person } of personRows) {
      const byTodo = role === "contact" ? contactsByTodo : requestersByTodo;
      const list = byTodo.get(todoId) ?? [];
      list.push(toPersonBrief(person));
      byTodo.set(todoId, list);
    }
    for (const { todoId, n } of db
      .select({ todoId: comments.todoId, n: count() })
      .from(comments)
      .where(inArray(comments.todoId, part))
      .groupBy(comments.todoId)
      .all()) {
      commentCounts.set(todoId, n);
    }
  }
  const projectById = projectRefs(
    db,
    rows.map((r) => r.projectId),
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
  }));
}

export function getTodo(db: Tx, id: number): Todo {
  const row = db.select().from(todos).where(eq(todos.id, id)).get();
  if (!row) throw notFound("Todo", id);
  return hydrate(db, [row])[0] as Todo;
}

interface PersonSummary {
  id: number;
  name: string;
}
const personSummary = (p: { id: number; displayName: string }): PersonSummary => ({
  id: p.id,
  name: p.displayName,
});

export function createTodo(ctx: Ctx, actor: string, input: CreateTodo): Todo {
  return ctx.db.transaction((tx) => {
    const at = now(ctx);
    assertProjectExists(tx, input.projectId);
    const labelRows = resolveLabels(tx, input.labels ?? []);
    const labelIds = [...new Set(labelRows.map((l) => l.id))];
    const linked = [
      ...resolvePeople(tx, at, input.requestedBy ?? [], true).map((p) => ({ p, role: "requester" as const })),
      ...resolvePeople(tx, at, input.contacts ?? [], true).map((p) => ({ p, role: "contact" as const })),
    ];
    const status = input.status ?? "open";
    const row = tx
      .insert(todos)
      .values({
        title: input.title,
        descriptionMd: input.descriptionMd ?? "",
        status,
        projectId: input.projectId ?? null,
        dueOn: input.dueOn ?? null,
        plannedOn: input.plannedOn ?? null,
        createdAt: at,
        updatedAt: at,
        doneAt: status === "done" ? at : null,
        lastActivityAt: at,
      })
      .returning()
      .get();
    if (labelIds.length > 0)
      tx.insert(todoLabels)
        .values(labelIds.map((labelId) => ({ todoId: row.id, labelId })))
        .run();
    if (linked.length > 0) {
      tx.insert(todoPeople)
        .values(linked.map(({ p, role }) => ({ todoId: row.id, personId: p.id, role, createdAt: at })))
        .run();
    }
    indexTodo(tx, row.id);
    const todo = hydrate(tx, [row])[0] as Todo;
    recordEvents(tx, actor, at, [
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
          },
        },
      },
    ]);
    return todo;
  });
}

const normNames = (list: readonly string[]): string =>
  list
    .map((n) => n.toLowerCase())
    .toSorted()
    .join("\n");
const sameNames = (a: readonly string[], b: readonly string[]): boolean => normNames(a) === normNames(b);

/** Description edits by one actor within this time merge into one history entry (autosave). */
export const DESCRIPTION_MERGE_MS = 10 * 60_000;

/**
 * Merges a description edit into the todo's last event when that is a description_changed by the
 * same actor less than 10 minutes ago: it keeps its `from`, takes the new `to` and time, and goes
 * away when the text is back to where it started. Returns false when a new event is needed.
 */
function coalesceDescription(tx: Tx, at: string, actor: string, todoId: number, to: string): boolean {
  const last = tx
    .select()
    .from(events)
    .where(eq(events.todoId, todoId))
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
  if (from === to) tx.delete(events).where(eq(events.id, last.id)).run();
  else
    tx.update(events)
      .set({ data: JSON.stringify({ from, to }), createdAt: at })
      .where(eq(events.id, last.id))
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
  tx: Tx,
  at: string,
  current: Todo,
  role: PersonRole,
  change: SetChange<PersonRef>,
): { role: PersonRole; from: PersonSummary[]; to: PersonSummary[] } | null {
  if (change.set === undefined && change.add === undefined && change.remove === undefined) return null;
  const before = current[ROLE_FIELD[role]];
  const ids = (refs: readonly PersonRef[] | undefined, create: boolean) =>
    refs === undefined ? undefined : resolvePeople(tx, at, refs, create).map((p) => p.id);
  const { next, added, removed } = diffIds(
    before.map((p) => p.id),
    { set: ids(change.set, true), add: ids(change.add, true), remove: ids(change.remove, false) },
  );
  if (added.length === 0 && removed.length === 0) return null;
  if (removed.length > 0) {
    tx.delete(todoPeople)
      .where(
        and(
          eq(todoPeople.todoId, current.id),
          eq(todoPeople.role, role),
          inArray(todoPeople.personId, removed),
        ),
      )
      .run();
  }
  if (added.length > 0) {
    tx.insert(todoPeople)
      .values(added.map((personId) => ({ todoId: current.id, personId, role, createdAt: at })))
      .run();
  }
  const byId = new Map(
    tx
      .select()
      .from(people)
      .where(inArray(people.id, next.length > 0 ? next : [-1]))
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
function applyChange(tx: Tx, at: string, actor: string, current: Todo, change: UpdateTodo): void {
  const set: Partial<TodoRow> = {};
  const evts: EventInput[] = [];
  const event = (kind: EventInput["kind"], data: unknown) => evts.push({ todoId: current.id, kind, data });

  if (change.title !== undefined && change.title !== current.title) {
    set.title = change.title;
    event("title_changed", { from: current.title, to: change.title });
  }
  if (change.descriptionMd !== undefined && change.descriptionMd !== current.descriptionMd) {
    set.descriptionMd = change.descriptionMd;
    if (!coalesceDescription(tx, at, actor, current.id, change.descriptionMd)) {
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
    assertProjectExists(tx, change.projectId);
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

  if (change.labels !== undefined || change.addLabels !== undefined || change.removeLabels !== undefined) {
    const names = (list: readonly string[] | undefined) =>
      list === undefined ? undefined : resolveLabels(tx, list).map((l) => l.name);
    const currentNames = current.labels.map((l) => l.name);
    const next = applyLabelChange(currentNames, {
      set: names(change.labels),
      add: names(change.addLabels),
      remove: names(change.removeLabels),
    });
    if (!sameNames(currentNames, next)) {
      const nextIds = resolveLabels(tx, next).map((l) => l.id);
      tx.delete(todoLabels).where(eq(todoLabels.todoId, current.id)).run();
      if (nextIds.length > 0) {
        tx.insert(todoLabels)
          .values(nextIds.map((labelId) => ({ todoId: current.id, labelId })))
          .run();
      }
      event("labels_changed", { from: currentNames, to: next });
    }
  }

  const requesters = applyPeopleChange(tx, at, current, "requester", {
    set: change.requestedBy,
    add: change.addRequestedBy,
    remove: change.removeRequestedBy,
  });
  if (requesters) event("people_changed", requesters);
  const contacts = applyPeopleChange(tx, at, current, "contact", {
    set: change.contacts,
    add: change.addContacts,
    remove: change.removeContacts,
  });
  if (contacts) event("people_changed", contacts);

  if (evts.length === 0 && Object.keys(set).length === 0) return;
  set.updatedAt = at;
  if (evts.length > 0 || set.descriptionMd !== undefined) set.lastActivityAt = at;
  tx.update(todos).set(set).where(eq(todos.id, current.id)).run();
  if (set.title !== undefined || set.descriptionMd !== undefined) indexTodo(tx, current.id);
  recordEvents(tx, actor, at, evts);
}

export function updateTodo(ctx: Ctx, actor: string, id: number, change: UpdateTodo): Todo {
  return ctx.db.transaction((tx) => {
    applyChange(tx, now(ctx), actor, getTodo(tx, id), change);
    return getTodo(tx, id);
  });
}

/** Applies one patch to many todos, all or nothing. */
export function bulkUpdate(ctx: Ctx, actor: string, ids: readonly number[], change: UpdateTodo): Todo[] {
  return ctx.db.transaction((tx) => {
    const rows = tx
      .select()
      .from(todos)
      .where(inArray(todos.id, [...ids]))
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
    const byId = new Map(hydrate(tx, rows).map((t) => [t.id, t]));
    for (const id of ids) applyChange(tx, at, actor, byId.get(id) as Todo, change);
    const after = new Map(
      hydrate(
        tx,
        tx
          .select()
          .from(todos)
          .where(inArray(todos.id, [...ids]))
          .all(),
      ).map((t) => [t.id, t]),
    );
    return ids.map((id) => after.get(id) as Todo);
  });
}

/** Deletes a todo with its comments, links and history (cascade), and its search rows. */
export function deleteTodo(ctx: Ctx, id: number): void {
  ctx.db.transaction((tx) => {
    const result = tx.delete(todos).where(eq(todos.id, id)).run();
    if (result.changes === 0) throw notFound("Todo", id);
    removeTodoFromIndex(tx, id);
  });
}

/**
 * Correlated subqueries name the outer table explicitly ("todos"."id"): drizzle leaves the table off
 * columns in some positions, and inside the subquery a bare "id" would mean the label's id.
 */

/** Importance for sorting: critical 4, high 3, medium 2, none 1, low 0. */
const priorityKey = sql`coalesce((
  SELECT CASE lower(l.value) WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 0 END
  FROM ${todoLabels} tl JOIN ${labels} l ON l.id = tl.label_id
  WHERE tl.todo_id = "todos"."id" AND lower(l.scope) = 'priority' AND lower(l.value) IN ('critical','high','medium','low')
  LIMIT 1
), 1)`;

const hasLabel = (name: string): SQL =>
  sql`EXISTS (SELECT 1 FROM ${todoLabels} tl JOIN ${labels} l ON l.id = tl.label_id WHERE tl.todo_id = "todos"."id" AND l.name = ${name})`;

function projectCondition(projectId: number | "inbox" | undefined): SQL | undefined {
  if (projectId === undefined) return undefined;
  return projectId === "inbox" ? isNull(todos.projectId) : eq(todos.projectId, projectId);
}

function listConditions(query: TodoListQuery, timeZone: string): SQL | undefined {
  const conditions: (SQL | undefined)[] = [];
  if (query.status !== "all") conditions.push(inArray(todos.status, query.status));
  conditions.push(projectCondition(query.projectId));
  for (const name of query.label ?? []) conditions.push(hasLabel(name));
  if (query.personId !== undefined) {
    const role = query.personRole === "any" ? sql`` : sql` AND tp.role = ${query.personRole}`;
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${todoPeople} tp WHERE tp.todo_id = "todos"."id" AND tp.person_id = ${query.personId}${role})`,
    );
  }
  if (query.q) conditions.push(sql`${todos.title} LIKE ${`%${escapeLike(query.q)}%`} ESCAPE '\\'`);
  if (query.dueBefore !== undefined) conditions.push(sql`${todos.dueOn} < ${query.dueBefore}`);
  if (query.plannedOn !== undefined) conditions.push(eq(todos.plannedOn, query.plannedOn));
  if (query.plannedFrom !== undefined) conditions.push(sql`${todos.plannedOn} >= ${query.plannedFrom}`);
  if (query.plannedTo !== undefined) conditions.push(sql`${todos.plannedOn} <= ${query.plannedTo}`);
  if (query.unplanned === true) conditions.push(isNull(todos.plannedOn));
  if (query.unplanned === false) conditions.push(isNotNull(todos.plannedOn));
  if (query.doneAfter !== undefined) {
    const start = startOfLocalDay(query.doneAfter, timeZone).toISOString();
    conditions.push(sql`(${todos.status} <> 'done' OR ${todos.doneAt} >= ${start})`);
  }
  return and(...conditions);
}

/**
 * Filtered, sorted page of todos. sort=due puts todos without a due date last in both orders;
 * sort=priority with order=desc lists critical first.
 */
export function listTodos(ctx: Pick<Ctx, "db" | "timeZone">, query: TodoListQuery): TodoPage {
  const { db } = ctx;
  const where = listConditions(query, ctx.timeZone);
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
  const rows = db
    .select()
    .from(todos)
    .where(where)
    .orderBy(...orderBy)
    .limit(query.limit)
    .offset(query.offset)
    .all();
  const { n } = db.get<{ n: number }>(
    sql`SELECT count(*) AS n FROM ${todos} ${where ? sql`WHERE ${where}` : sql``}`,
  );
  return { items: hydrate(db, rows), total: n, limit: query.limit, offset: query.offset };
}

/** Next up: active todos ranked by the shared scoring, with today in the user's time zone. */
export function nextUp(ctx: Ctx, query: NextQuery): NextUp {
  const conditions: (SQL | undefined)[] = [
    inArray(todos.status, [...ACTIVE_STATUSES]),
    projectCondition(query.projectId),
  ];
  for (const name of query.label ?? []) conditions.push(hasLabel(name));
  const rows = ctx.db
    .select()
    .from(todos)
    .where(and(...conditions))
    .all();
  return buildNextUp(hydrate(ctx.db, rows), {
    mode: query.mode,
    now: ctx.clock(),
    timeZone: ctx.timeZone,
    limit: query.limit,
  });
}
