import {
  addDays,
  type BlockSpace,
  DONE_BUCKETS,
  type DoneBucket,
  daysBetween,
  type MeetingPersonStats,
  doneBucket,
  type ProjectRef,
  type RequesterStats,
  type StatsGroup,
  startOfLocalDay,
  toLocalDate,
  toLocalTime,
  type WeekStats,
  type WorkStats,
  type WorkStatsQuery,
} from "@organizer/shared";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { people, todoPeople, todos } from "../db/schema.ts";
import { listRepeatOccurrences } from "./block-series.ts";
import { listBlocks } from "./blocks.ts";
import type { Ctx } from "./context.ts";
import { peopleOf } from "./meeting-people.ts";
import { listOccurrences } from "./meetings.ts";
import { owned } from "./owned.ts";
import { projectRefs } from "./projects.ts";
import { chunks } from "./sql.ts";

/**
 * Statistics of work over a period (shared work-stats.ts). Worked time is planned time that has
 * already happened: blocks and planned dates of repeating todos, cut to the period and to now, split
 * into 15 minute steps so every minute lands on its local day, week and hour.
 */

const STEP_MS = 15 * 60_000;
/** A Monday, to work out the weekday of a date without a time zone. */
const MONDAY = "2024-01-01";
const INBOX = "inbox";
const UNTITLED = "untitled";

const round = (minutes: number): number => Math.round(minutes);
const weekdayOf = (date: string): number => ((daysBetween(MONDAY, date) % 7) + 7) % 7;
const mondayOf = (date: string): string => addDays(date, -weekdayOf(date));

interface Piece {
  start: number;
  end: number;
  todoId: number | null;
  project: ProjectRef | null;
  /** Your time in a shared project (its todo and project ids are counted there). */
  space: BlockSpace | null;
}

/** "inbox", "untitled", the project id or "s<id>" for a shared project: the group of worked time or a done todo. */
const groupKey = (
  todoId: number | null,
  project: ProjectRef | null,
  space: BlockSpace | null = null,
): string =>
  space !== null
    ? `s${space.id}`
    : todoId === null
      ? UNTITLED
      : project === null
        ? INBOX
        : String(project.id);

const groupName = (key: string, project: ProjectRef | null, space: BlockSpace | null = null): string =>
  space !== null
    ? space.name
    : key === INBOX
      ? "Inbox"
      : key === UNTITLED
        ? "Own title"
        : (project?.name ?? "Project");

export function workStats(ctx: Ctx, query: WorkStatsQuery): WorkStats {
  const { from, to } = query;
  const tz = ctx.timeZone;
  const lo = startOfLocalDay(from, tz).getTime();
  const hi = startOfLocalDay(addDays(to, 1), tz).getTime();
  const workedHi = Math.min(hi, ctx.clock().getTime());
  const clip = (startAt: string, endAt: string): [number, number] | null => {
    const start = Math.max(Date.parse(startAt), lo);
    const end = Math.min(Date.parse(endAt), workedHi);
    return end > start ? [start, end] : null;
  };

  // ---------- worked time ----------
  const pieces: Piece[] = [];
  // Your own blocks and your time in the shared projects you are a member of.
  for (const block of listBlocks(ctx, { from, to, shared: true })) {
    const span = clip(block.startAt, block.endAt);
    if (span)
      pieces.push({
        start: span[0],
        end: span[1],
        todoId: block.todoId,
        project: block.project,
        space: block.space,
      });
  }
  for (const o of listRepeatOccurrences(ctx, { from, to })) {
    const span = clip(o.startAt, o.endAt);
    if (span)
      pieces.push({ start: span[0], end: span[1], todoId: o.todo.id, project: o.project, space: null });
  }

  const days = new Map<string, { worked: number; done: number }>();
  for (let date = from; date <= to; date = addDays(date, 1)) days.set(date, { worked: 0, done: 0 });
  const weeks = new Map<
    string,
    { worked: number; meeting: number; created: number; done: number; projects: Map<string, number> }
  >();
  for (let monday = mondayOf(from); monday <= to; monday = addDays(monday, 7))
    weeks.set(monday, { worked: 0, meeting: 0, created: 0, done: 0, projects: new Map() });
  const hours = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  const groups = new Map<
    string,
    { project: ProjectRef | null; space: BlockSpace | null; minutes: number; done: number }
  >();
  const group = (key: string, project: ProjectRef | null, space: BlockSpace | null = null) => {
    let entry = groups.get(key);
    if (!entry) {
      entry = { project, space, minutes: 0, done: 0 };
      groups.set(key, entry);
    }
    return entry;
  };
  const minutesByTodo = new Map<number, number>();

  /** Calls `add` with the local date, hour and minutes of every 15 minute step of a span. */
  const steps = (start: number, end: number, add: (date: string, hour: number, minutes: number) => void) => {
    for (let at = start; at < end; at += STEP_MS) {
      const minutes = (Math.min(end, at + STEP_MS) - at) / 60_000;
      add(toLocalDate(at, tz), Number(toLocalTime(at, tz).slice(0, 2)), minutes);
    }
  };

  let workedMinutes = 0;
  for (const piece of pieces) {
    const key = groupKey(piece.todoId, piece.project, piece.space);
    const name = groupName(key, piece.project, piece.space);
    const minutes = (piece.end - piece.start) / 60_000;
    workedMinutes += minutes;
    group(key, piece.project, piece.space).minutes += minutes;
    // Requesters are people of your own account: time in shared projects counts for nobody there.
    if (piece.todoId !== null && piece.space === null)
      minutesByTodo.set(piece.todoId, (minutesByTodo.get(piece.todoId) ?? 0) + minutes);
    steps(piece.start, piece.end, (date, hour, m) => {
      const day = days.get(date);
      if (day) day.worked += m;
      const week = weeks.get(mondayOf(date));
      if (week) {
        week.worked += m;
        week.projects.set(name, (week.projects.get(name) ?? 0) + m);
      }
      const row = hours[weekdayOf(date)] as number[];
      row[hour] = (row[hour] ?? 0) + m;
    });
  }

  let meetingMinutes = 0;
  const meetingTime: { meetingId: number; minutes: number }[] = [];
  for (const o of listOccurrences(ctx, { from, to })) {
    const span = clip(o.startAt, o.endAt);
    if (!span) continue;
    meetingMinutes += (span[1] - span[0]) / 60_000;
    meetingTime.push({ meetingId: o.meetingId, minutes: (span[1] - span[0]) / 60_000 });
    steps(span[0], span[1], (date, _hour, m) => {
      const week = weeks.get(mondayOf(date));
      if (week) week.meeting += m;
    });
  }

  // Time in meetings per person: each date counts in full for every person of its meeting.
  const attendees = peopleOf(
    ctx,
    meetingTime.map((m) => m.meetingId),
  );
  const withPerson = new Map<number, { name: string; minutes: number; dates: number }>();
  let meetingMinutesWithoutPeople = 0;
  for (const { meetingId, minutes } of meetingTime) {
    const list = attendees.get(meetingId) ?? [];
    if (list.length === 0) meetingMinutesWithoutPeople += minutes;
    for (const person of list) {
      const entry = withPerson.get(person.id) ?? { name: person.displayName, minutes: 0, dates: 0 };
      entry.minutes += minutes;
      entry.dates += 1;
      withPerson.set(person.id, entry);
    }
  }
  const meetingPeople: MeetingPersonStats[] = [...withPerson]
    .map(([id, p]) => ({ person: { id, name: p.name }, minutes: round(p.minutes), dates: p.dates }))
    .toSorted(
      (a, b) => b.minutes - a.minutes || b.dates - a.dates || a.person.name.localeCompare(b.person.name),
    )
    .slice(0, 10);

  // ---------- todos created and done ----------
  const loIso = new Date(lo).toISOString();
  const hiIso = new Date(hi).toISOString();
  const created = ctx.db
    .select({ createdAt: todos.createdAt })
    .from(todos)
    .where(owned(ctx, todos, and(gte(todos.createdAt, loIso), lt(todos.createdAt, hiIso))))
    .all();
  for (const row of created) {
    const week = weeks.get(mondayOf(toLocalDate(row.createdAt, tz)));
    if (week) week.created += 1;
  }
  const done = ctx.db
    .select({ id: todos.id, projectId: todos.projectId, createdAt: todos.createdAt, doneAt: todos.doneAt })
    .from(todos)
    .where(
      owned(ctx, todos, and(eq(todos.status, "done"), gte(todos.doneAt, loIso), lt(todos.doneAt, hiIso))),
    )
    .all();
  const projects = projectRefs(
    ctx,
    done.map((d) => d.projectId),
  );
  const durations: number[] = [];
  const buckets = new Map<DoneBucket, number>(DONE_BUCKETS.map((b) => [b, 0]));
  for (const row of done) {
    if (row.doneAt === null) continue;
    const date = toLocalDate(row.doneAt, tz);
    const day = days.get(date);
    if (day) day.done += 1;
    const week = weeks.get(mondayOf(date));
    if (week) week.done += 1;
    const project = row.projectId === null ? null : (projects.get(row.projectId) ?? null);
    group(groupKey(row.id, project), project).done += 1;
    const ms = Math.max(0, Date.parse(row.doneAt) - Date.parse(row.createdAt));
    durations.push(ms);
    const bucket = doneBucket(ms);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  const sorted = durations.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const medianDoneMs =
    sorted.length === 0
      ? null
      : sorted.length % 2 === 1
        ? (sorted[middle] as number)
        : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;

  // ---------- requesters ----------
  const doneIds = new Set(done.map((d) => d.id));
  const todoIds = [...new Set([...minutesByTodo.keys(), ...doneIds])];
  const byPerson = new Map<number, { name: string; minutes: number; done: number }>();
  for (const part of chunks(todoIds)) {
    for (const row of ctx.db
      .select({
        todoId: todoPeople.todoId,
        personId: people.id,
        firstName: people.firstName,
        lastName: people.lastName,
      })
      .from(todoPeople)
      .innerJoin(people, and(eq(people.accountId, todoPeople.accountId), eq(people.id, todoPeople.personId)))
      .where(owned(ctx, todoPeople, and(eq(todoPeople.role, "requester"), inArray(todoPeople.todoId, part))))
      .all()) {
      let entry = byPerson.get(row.personId);
      if (!entry) {
        entry = { name: `${row.firstName} ${row.lastName}`.trim(), minutes: 0, done: 0 };
        byPerson.set(row.personId, entry);
      }
      entry.minutes += minutesByTodo.get(row.todoId) ?? 0;
      if (doneIds.has(row.todoId)) entry.done += 1;
    }
  }
  const requesterList: RequesterStats[] = [...byPerson]
    .map(([id, p]) => ({ person: { id, name: p.name }, minutes: Math.round(p.minutes), done: p.done }))
    .filter((r) => r.minutes > 0 || r.done > 0)
    .toSorted(
      (a, b) => b.minutes - a.minutes || b.done - a.done || a.person.name.localeCompare(b.person.name),
    );
  const rest = requesterList.slice(10);

  const groupList: StatsGroup[] = [...groups]
    .map(([key, g]) => ({
      kind:
        key === INBOX ? ("inbox" as const) : key === UNTITLED ? ("untitled" as const) : ("project" as const),
      project: key === INBOX || key === UNTITLED ? null : g.project,
      space: g.space,
      minutes: round(g.minutes),
      done: g.done,
    }))
    .filter((g) => g.minutes > 0 || g.done > 0)
    .toSorted((a, b) => b.minutes - a.minutes || b.done - a.done);
  const weekList: WeekStats[] = [...weeks].map(([start, w]) => ({
    start,
    workedMinutes: round(w.worked),
    meetingMinutes: round(w.meeting),
    created: w.created,
    done: w.done,
    projects: [...w.projects]
      .map(([name, minutes]) => ({ name, minutes: round(minutes) }))
      .filter((p) => p.minutes > 0)
      .toSorted((a, b) => b.minutes - a.minutes),
  }));

  return {
    from,
    to,
    totals: {
      workedMinutes: round(workedMinutes),
      meetingMinutes: round(meetingMinutes),
      created: created.length,
      done: done.length,
      medianDoneMs,
    },
    projects: groupList,
    requesters: requesterList.slice(0, 10),
    otherRequesters:
      rest.length === 0
        ? null
        : {
            people: rest.length,
            minutes: rest.reduce((n, r) => n + r.minutes, 0),
            done: rest.reduce((n, r) => n + r.done, 0),
          },
    meetingPeople,
    meetingMinutesWithoutPeople: round(meetingMinutesWithoutPeople),
    weeks: weekList,
    days: [...days].map(([date, d]) => ({ date, workedMinutes: round(d.worked), done: d.done })),
    hours: hours.map((row) => row.map(round)),
    doneDurations: DONE_BUCKETS.map((bucket) => ({ bucket, count: buckets.get(bucket) ?? 0 })),
  };
}
