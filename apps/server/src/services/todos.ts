import {
  ACTIVE_STATUSES,
  applyLabelChange,
  buildNextUp,
  type CreateTodo,
  type NextQuery,
  type NextUp,
  type ProjectRef,
  sortLabels,
  type Todo,
  type TodoListQuery,
  type TodoPage,
  todoDurationMs,
  type UpdateTodo,
} from "@organizer/shared";
import { and, asc, desc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { labels, people, projects, todoLabels, todoPeople, todos } from "../db/schema.ts";
import { ApiError, notFound } from "../http/errors.ts";
import { type Ctx, now, type Tx } from "./context.ts";
import { type EventInput, recordEvents } from "./events.ts";
import { resolveLabels, toLabel } from "./labels.ts";
import { resolvePeople, toPerson } from "./people.ts";

export type TodoRow = typeof todos.$inferSelect;

/** SQLite allows many bound parameters, but chunks keep big Next up loads safe. */
const CHUNK = 500;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/** Turns todo rows into API todos with labels, requesters and project. */
export function hydrate(db: Tx, rows: readonly TodoRow[]): Todo[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const labelsByTodo = new Map<number, ReturnType<typeof toLabel>[]>();
  const peopleByTodo = new Map<number, ReturnType<typeof toPerson>[]>();
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
      .select({ todoId: todoPeople.todoId, person: people })
      .from(todoPeople)
      .innerJoin(people, eq(people.id, todoPeople.personId))
      .where(and(inArray(todoPeople.todoId, part), eq(todoPeople.role, "requester")))
      .orderBy(asc(todoPeople.createdAt), asc(people.id))
      .all();
    for (const { todoId, person } of personRows) {
      const list = peopleByTodo.get(todoId) ?? [];
      list.push(toPerson(person));
      peopleByTodo.set(todoId, list);
    }
  }
  const projectIds = [...new Set(rows.map((r) => r.projectId).filter((id) => id !== null))];
  const projectById = new Map<number, ProjectRef>();
  for (const part of chunks(projectIds)) {
    for (const p of db
      .select({ id: projects.id, slug: projects.slug, name: projects.name, color: projects.color })
      .from(projects)
      .where(inArray(projects.id, part))
      .all()) {
      projectById.set(p.id, p);
    }
  }
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
    requestedBy: peopleByTodo.get(row.id) ?? [],
    project: row.projectId === null ? null : (projectById.get(row.projectId) ?? null),
  }));
}

export function getTodo(db: Tx, id: number): Todo {
  const row = db.select().from(todos).where(eq(todos.id, id)).get();
  if (!row) throw notFound("Todo", id);
  return hydrate(db, [row])[0] as Todo;
}

function assertProject(db: Tx, projectId: number | null | undefined): void {
  if (projectId === null || projectId === undefined) return;
  const row = db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get();
  if (!row) {
    throw new ApiError(
      "validation_failed",
      `Project ${projectId} does not exist. Use an id from GET /api/v1/projects, or null for the Inbox.`,
    );
  }
}

const personSummary = (p: { id: number; displayName: string }) => ({ id: p.id, name: p.displayName });

export function createTodo(ctx: Ctx, actor: string, input: CreateTodo): Todo {
  return ctx.db.transaction((tx) => {
    const at = now(ctx);
    assertProject(tx, input.projectId);
    const labelRows = resolveLabels(tx, input.labels ?? []);
    const labelIds = [...new Set(labelRows.map((l) => l.id))];
    const requesters = resolvePeople(tx, at, input.requestedBy ?? [], true);
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
    if (requesters.length > 0) {
      tx.insert(todoPeople)
        .values(
          requesters.map((p) => ({
            todoId: row.id,
            personId: p.id,
            role: "requester" as const,
            createdAt: at,
          })),
        )
        .run();
    }
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
    event("description_changed", { from: current.descriptionMd, to: change.descriptionMd });
  }
  if (change.status !== undefined && change.status !== current.status) {
    set.status = change.status;
    if (change.status === "done") set.doneAt = at;
    else if (current.status === "done") set.doneAt = null;
    event("status_changed", { from: current.status, to: change.status });
  }
  if (change.projectId !== undefined && change.projectId !== current.projectId) {
    assertProject(tx, change.projectId);
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

  if (
    change.requestedBy !== undefined ||
    change.addRequestedBy !== undefined ||
    change.removeRequestedBy !== undefined
  ) {
    const currentIds = current.requestedBy.map((p) => p.id);
    let nextIds: number[];
    if (change.requestedBy !== undefined) {
      nextIds = resolvePeople(tx, at, change.requestedBy, true).map((p) => p.id);
    } else {
      const added = resolvePeople(tx, at, change.addRequestedBy ?? [], true).map((p) => p.id);
      const removed = new Set(resolvePeople(tx, at, change.removeRequestedBy ?? [], false).map((p) => p.id));
      nextIds = [...new Set([...currentIds, ...added])].filter((id) => !removed.has(id));
    }
    const removedIds = currentIds.filter((id) => !nextIds.includes(id));
    const addedIds = nextIds.filter((id) => !currentIds.includes(id));
    if (removedIds.length > 0 || addedIds.length > 0) {
      if (removedIds.length > 0) {
        tx.delete(todoPeople)
          .where(and(eq(todoPeople.todoId, current.id), inArray(todoPeople.personId, removedIds)))
          .run();
      }
      if (addedIds.length > 0) {
        tx.insert(todoPeople)
          .values(
            addedIds.map((personId) => ({
              todoId: current.id,
              personId,
              role: "requester" as const,
              createdAt: at,
            })),
          )
          .run();
      }
      const after = tx
        .select()
        .from(people)
        .where(inArray(people.id, nextIds.length > 0 ? nextIds : [-1]))
        .all();
      const byId = new Map(after.map((p) => [p.id, toPerson(p)]));
      event("people_changed", {
        from: current.requestedBy.map(personSummary),
        to: nextIds
          .map((id) => byId.get(id))
          .filter((p) => p !== undefined)
          .map(personSummary),
      });
    }
  }

  if (evts.length === 0 && Object.keys(set).length === 0) return;
  set.updatedAt = at;
  if (evts.length > 0) set.lastActivityAt = at;
  tx.update(todos).set(set).where(eq(todos.id, current.id)).run();
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

export function deleteTodo(ctx: Ctx, id: number): void {
  const result = ctx.db.delete(todos).where(eq(todos.id, id)).run();
  if (result.changes === 0) throw notFound("Todo", id);
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

const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);

function listConditions(query: TodoListQuery): SQL | undefined {
  const conditions: (SQL | undefined)[] = [];
  if (query.status !== "all") conditions.push(inArray(todos.status, query.status));
  conditions.push(projectCondition(query.projectId));
  for (const name of query.label ?? []) conditions.push(hasLabel(name));
  if (query.personId !== undefined) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${todoPeople} tp WHERE tp.todo_id = "todos"."id" AND tp.person_id = ${query.personId})`,
    );
  }
  if (query.q) conditions.push(sql`${todos.title} LIKE ${`%${escapeLike(query.q)}%`} ESCAPE '\\'`);
  if (query.dueBefore !== undefined) conditions.push(sql`${todos.dueOn} < ${query.dueBefore}`);
  if (query.plannedOn !== undefined) conditions.push(eq(todos.plannedOn, query.plannedOn));
  return and(...conditions);
}

/**
 * Filtered, sorted page of todos. sort=due puts todos without a due date last in both orders;
 * sort=priority with order=desc lists critical first.
 */
export function listTodos(db: Tx, query: TodoListQuery): TodoPage {
  const where = listConditions(query);
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
