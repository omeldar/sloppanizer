import {
  ACTIVE_STATUSES,
  addDays,
  daysSince,
  type PeopleStats,
  type PeopleStatsQuery,
  type PersonRole,
  type PersonStat,
  type PersonStatDetail,
  type PersonStatsQuery,
  startOfLocalDay,
  toLocalDate,
  todoDurationMs,
  type TodoStatus,
} from "@organizer/shared";
import { and, eq, gte, lt, type SQL } from "drizzle-orm";
import { people, todoPeople, todos } from "../db/schema.ts";
import type { Ctx } from "./context.ts";
import { byName, filterPeople, getPersonRow, loadPeople, toPersonBrief } from "./people.ts";
import { hasLabel, projectCondition } from "./todos.ts";

/** One person-todo link in the filtered set. */
interface Link {
  todoId: number;
  personId: number;
  role: PersonRole;
  linkedAt: string;
  status: TodoStatus;
  createdAt: string;
  doneAt: string | null;
}

type TodoFilters = Pick<PeopleStatsQuery, "from" | "to" | "label" | "projectId">;

const isOpen = (status: TodoStatus): boolean => (ACTIVE_STATUSES as readonly string[]).includes(status);

/** Person-todo links whose todo passes the todo filters (period on the local created date, labels, project). */
function linksInSet(ctx: Ctx, filters: TodoFilters, personId?: number): Link[] {
  const conditions: (SQL | undefined)[] = [projectCondition(filters.projectId)];
  if (filters.from)
    conditions.push(gte(todos.createdAt, startOfLocalDay(filters.from, ctx.timeZone).toISOString()));
  if (filters.to)
    conditions.push(lt(todos.createdAt, startOfLocalDay(addDays(filters.to, 1), ctx.timeZone).toISOString()));
  for (const name of filters.label ?? []) conditions.push(hasLabel(name));
  if (personId !== undefined) conditions.push(eq(todoPeople.personId, personId));
  return ctx.db
    .select({
      todoId: todoPeople.todoId,
      personId: todoPeople.personId,
      role: todoPeople.role,
      linkedAt: todoPeople.createdAt,
      status: todos.status,
      createdAt: todos.createdAt,
      doneAt: todos.doneAt,
    })
    .from(todoPeople)
    .innerJoin(todos, eq(todos.id, todoPeople.todoId))
    .where(and(...conditions))
    .all();
}

/** The value at fraction q of the sorted list: median as the mean of the middle two, p90 by nearest rank. */
export function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

export function p90(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.ceil(0.9 * sorted.length) - 1] as number;
}

const durations = (links: readonly Pick<Link, "status" | "createdAt" | "doneAt">[]): number[] =>
  links
    .filter((l) => l.status === "done")
    .map((l) => todoDurationMs(l.createdAt, l.doneAt))
    .filter((ms): ms is number => ms !== null)
    .toSorted((a, b) => a - b);

function statOf(ctx: Ctx, person: PersonStat["person"], links: readonly Link[], today: string): PersonStat {
  const requested = links.filter((l) => l.role === "requester");
  const contact = links.filter((l) => l.role === "contact");
  const open = requested.filter((l) => isOpen(l.status));
  const took = durations(requested);
  return {
    person,
    requested: {
      total: requested.length,
      open: open.length,
      done: requested.filter((l) => l.status === "done").length,
      medianDoneMs: median(took),
      p90DoneMs: p90(took),
      oldestOpenDays:
        open.length === 0
          ? null
          : Math.max(0, ...open.map((l) => daysSince(l.createdAt, today, ctx.timeZone))),
      lastAt:
        requested.length === 0 ? null : requested.map((l) => l.linkedAt).reduce((a, b) => (a > b ? a : b)),
    },
    contact: {
      total: contact.length,
      open: contact.filter((l) => isOpen(l.status)).length,
      done: contact.filter((l) => l.status === "done").length,
    },
  };
}

function groupByPerson(links: readonly Link[]): Map<number, Link[]> {
  const out = new Map<number, Link[]>();
  for (const link of links) out.set(link.personId, [...(out.get(link.personId) ?? []), link]);
  return out;
}

const name = (a: PersonStat, b: PersonStat) => byName(a.person, b.person);

const roleKey = (stat: PersonStat, role: PersonRole) =>
  role === "requester" ? stat.requested : stat.contact;

/**
 * Per-person numbers over the filtered todos. Topic, tag and team choose the people (like the
 * directory); period, label and project narrow the todos. Only people with at least one link of the
 * chosen role in the set are listed. Totals count the distinct todos behind the listed people.
 */
export function peopleStats(ctx: Ctx, query: PeopleStatsQuery): PeopleStats {
  const today = toLocalDate(ctx.clock(), ctx.timeZone);
  const byPerson = groupByPerson(linksInSet(ctx, query));
  const chosen = filterPeople(loadPeople(ctx.db, ctx.db.select().from(people).all()), query).filter((p) =>
    (byPerson.get(p.id) ?? []).some((l) => l.role === query.role),
  );
  const stats = chosen.map((p) => {
    const { id, firstName, lastName, displayName, note, team, email } = p;
    const brief = { id, firstName, lastName, displayName, note, team, email };
    return statOf(ctx, brief, byPerson.get(p.id) ?? [], today);
  });
  const desc = (pick: (s: PersonStat) => number) => (a: PersonStat, b: PersonStat) =>
    pick(b) - pick(a) || name(a, b);
  const sorted = stats.toSorted(
    {
      total: desc((s) => roleKey(s, query.role).total),
      open: desc((s) => roleKey(s, query.role).open),
      done: desc((s) => roleKey(s, query.role).done),
      speed: (a: PersonStat, b: PersonStat) => {
        const x = a.requested.medianDoneMs;
        const y = b.requested.medianDoneMs;
        if (x === null || y === null) return x === y ? name(a, b) : x === null ? 1 : -1;
        return x - y || name(a, b);
      },
      recent: (a: PersonStat, b: PersonStat) =>
        (b.requested.lastAt ?? "").localeCompare(a.requested.lastAt ?? "") || name(a, b),
      name,
    }[query.sort],
  );

  const totalTodos = new Map<number, Link>();
  for (const p of chosen) {
    for (const link of byPerson.get(p.id) ?? [])
      if (link.role === query.role) totalTodos.set(link.todoId, link);
  }
  const all = [...totalTodos.values()];
  return {
    from: query.from ?? null,
    to: query.to ?? null,
    role: query.role,
    totals: {
      todos: all.length,
      open: all.filter((l) => isOpen(l.status)).length,
      done: all.filter((l) => l.status === "done").length,
      medianDoneMs: median(durations(all)),
    },
    items: sorted.slice(0, query.limit),
  };
}

/** The 12 months ending with the current one, "YYYY-MM", oldest first. */
function lastMonths(today: string): string[] {
  const [y, m] = today.split("-").map(Number) as [number, number];
  return Array.from({ length: 12 }, (_, i) => {
    const index = y * 12 + (m - 1) - (11 - i);
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
  });
}

/** One person's numbers with the last 12 months. 404 for an unknown person; zeros without todos. */
export function personStats(ctx: Ctx, personId: number, query: PersonStatsQuery): PersonStatDetail {
  const row = getPersonRow(ctx.db, personId);
  const today = toLocalDate(ctx.clock(), ctx.timeZone);
  const links = linksInSet(ctx, query, personId);
  const months = lastMonths(today).map((month) => ({ month, requested: 0, done: 0, contact: 0 }));
  const byMonth = new Map(months.map((m) => [m.month, m]));
  const monthOf = (instant: string) => byMonth.get(toLocalDate(instant, ctx.timeZone).slice(0, 7));
  for (const link of links) {
    const created = monthOf(link.createdAt);
    if (link.role === "contact") {
      if (created) created.contact += 1;
      continue;
    }
    if (created) created.requested += 1;
    if (link.status === "done" && link.doneAt) {
      const done = monthOf(link.doneAt);
      if (done) done.done += 1;
    }
  }
  return { stat: statOf(ctx, toPersonBrief(row), links, today), months };
}
