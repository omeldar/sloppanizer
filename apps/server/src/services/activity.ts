import type { Activity, ActivityEvent, ActivityItem } from "@organizer/shared";
import { desc, eq, inArray } from "drizzle-orm";
import { events, todos } from "../db/schema.ts";
import { notFound } from "../http/errors.ts";
import { commentRows, toComment } from "./comments.ts";
import type { Scoped } from "./context.ts";
import { owned } from "./owned.ts";
import { projectRefs } from "./projects.ts";

/** At most this many items per thread (the newest ones). */
export const ACTIVITY_CAP = 2000;

type EventRow = typeof events.$inferSelect;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const projectId = (value: unknown): number | null => (typeof value === "number" ? value : null);

/** Event kinds whose data names other todos, and the fields that hold them. */
const TODO_REF_FIELDS: Partial<Record<string, readonly string[]>> = {
  parent_changed: ["from", "to"],
  subtasks_changed: ["added", "removed"],
  links_changed: ["added", "removed"],
  recurred: ["next"],
};

const refIds = (value: unknown): number[] => {
  if (Array.isArray(value)) return value.flatMap(refIds);
  return isRecord(value) && typeof value.id === "number" ? [value.id] : [];
};

/** Replaces the stored title of every todo reference with the current one (null = deleted). */
function withCurrentTitles(value: unknown, titles: ReadonlyMap<number, string>): unknown {
  if (Array.isArray(value)) return value.map((v) => withCurrentTitles(v, titles));
  if (isRecord(value) && typeof value.id === "number")
    return { ...value, title: titles.get(value.id) ?? null };
  return value;
}

/**
 * Event data as clients see it: description texts become their lengths, project ids become
 * { id, name|null } (null name = deleted project), people_changed always has a role.
 */
function normalize(rows: readonly EventRow[], sc: Scoped): ActivityEvent[] {
  const parsed = rows.map((row) => ({ row, data: JSON.parse(row.data) as unknown }));
  const ids = parsed
    .filter(({ row }) => row.kind === "project_changed")
    .flatMap(({ data }) => (isRecord(data) ? [projectId(data.from), projectId(data.to)] : []));
  const projects = projectRefs(sc, ids);
  const todoIds = [
    ...new Set(
      parsed.flatMap(({ row, data }) =>
        isRecord(data) ? (TODO_REF_FIELDS[row.kind] ?? []).flatMap((field) => refIds(data[field])) : [],
      ),
    ),
  ];
  const titles = new Map(
    todoIds.length === 0
      ? []
      : sc.db
          .select({ id: todos.id, title: todos.title })
          .from(todos)
          .where(owned(sc, todos, inArray(todos.id, todoIds)))
          .all()
          .map((t) => [t.id, t.title] as const),
  );
  const ref = (value: unknown) => {
    const id = projectId(value);
    return id === null ? null : { id, name: projects.get(id)?.name ?? null };
  };
  return parsed.map(({ row, data: raw }) => {
    let data: Record<string, unknown> = isRecord(raw) ? raw : {};
    if (row.kind === "description_changed") {
      data = {
        fromChars: typeof data.from === "string" ? data.from.length : 0,
        toChars: typeof data.to === "string" ? data.to.length : 0,
      };
    } else if (row.kind === "project_changed") {
      data = { from: ref(data.from), to: ref(data.to) };
    } else if (row.kind === "people_changed") {
      data = { role: "requester", ...data };
    } else if (TODO_REF_FIELDS[row.kind]) {
      const fields = TODO_REF_FIELDS[row.kind] ?? [];
      data = Object.fromEntries(
        Object.entries(data).map(([key, value]) => [
          key,
          fields.includes(key) ? withCurrentTitles(value, titles) : value,
        ]),
      );
    }
    return {
      id: row.id,
      todoId: row.todoId as number,
      actor: row.actor,
      kind: row.kind as ActivityEvent["kind"],
      data,
      createdAt: row.createdAt,
    };
  });
}

const itemTime = (item: ActivityItem): string =>
  item.type === "event" ? item.event.createdAt : item.comment.createdAt;
const itemId = (item: ActivityItem): number => (item.type === "event" ? item.event.id : item.comment.id);

/** Comments and history of a todo in one thread, oldest first; same time: events first, then by id. */
export function getActivity(sc: Scoped, todoId: number): Activity {
  if (
    !sc.db
      .select({ id: todos.id })
      .from(todos)
      .where(owned(sc, todos, eq(todos.id, todoId)))
      .get()
  )
    throw notFound("Todo", todoId);
  const eventRows = sc.db
    .select()
    .from(events)
    .where(owned(sc, events, eq(events.todoId, todoId)))
    .orderBy(desc(events.createdAt), desc(events.id))
    .limit(ACTIVITY_CAP)
    .all();
  const items: ActivityItem[] = [
    ...normalize(eventRows, sc).map((event) => ({ type: "event" as const, event })),
    ...commentRows(sc, todoId).map((row) => ({ type: "comment" as const, comment: toComment(row) })),
  ];
  items.sort(
    (a, b) =>
      itemTime(a).localeCompare(itemTime(b)) ||
      (a.type === b.type ? 0 : a.type === "event" ? -1 : 1) ||
      itemId(a) - itemId(b),
  );
  return { todoId, items: items.slice(-ACTIVITY_CAP) };
}
