import type { Activity, ActivityEvent, ActivityItem } from "@organizer/shared";
import { desc, eq } from "drizzle-orm";
import { events, todos } from "../db/schema.ts";
import { notFound } from "../http/errors.ts";
import { commentRows, toComment } from "./comments.ts";
import type { Tx } from "./context.ts";
import { projectRefs } from "./projects.ts";

/** At most this many items per thread (the newest ones). */
export const ACTIVITY_CAP = 2000;

type EventRow = typeof events.$inferSelect;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const projectId = (value: unknown): number | null => (typeof value === "number" ? value : null);

/**
 * Event data as clients see it: description texts become their lengths, project ids become
 * { id, name|null } (null name = deleted project), people_changed always has a role.
 */
function normalize(rows: readonly EventRow[], db: Tx): ActivityEvent[] {
  const parsed = rows.map((row) => ({ row, data: JSON.parse(row.data) as unknown }));
  const ids = parsed
    .filter(({ row }) => row.kind === "project_changed")
    .flatMap(({ data }) => (isRecord(data) ? [projectId(data.from), projectId(data.to)] : []));
  const projects = projectRefs(db, ids);
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
export function getActivity(db: Tx, todoId: number): Activity {
  if (!db.select({ id: todos.id }).from(todos).where(eq(todos.id, todoId)).get())
    throw notFound("Todo", todoId);
  const eventRows = db
    .select()
    .from(events)
    .where(eq(events.todoId, todoId))
    .orderBy(desc(events.createdAt), desc(events.id))
    .limit(ACTIVITY_CAP)
    .all();
  const items: ActivityItem[] = [
    ...normalize(eventRows, db).map((event) => ({ type: "event" as const, event })),
    ...commentRows(db, todoId).map((row) => ({ type: "comment" as const, comment: toComment(row) })),
  ];
  items.sort(
    (a, b) =>
      itemTime(a).localeCompare(itemTime(b)) ||
      (a.type === b.type ? 0 : a.type === "event" ? -1 : 1) ||
      itemId(a) - itemId(b),
  );
  return { todoId, items: items.slice(-ACTIVITY_CAP) };
}
