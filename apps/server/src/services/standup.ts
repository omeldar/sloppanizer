import {
  describeEvent,
  formatDate,
  type MarkInput,
  type MeetingNote,
  type MeetingNoteInput,
  nextSeriesOccurrence,
  type SaidItem,
  type Standup,
  STANDUP_KINDS,
  STANDUP_UPDATE_KINDS,
  type StandupCounts,
  type StandupFilter,
  type StandupItem,
  type StandupKind,
  type StandupQuery,
  startOfLocalDay,
  toLocalDate,
  type TodoRef,
} from "@organizer/shared";
import { and, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { comments, events, meetingNotes, standupMarks, todoLabels, todos } from "../db/schema.ts";
import { ApiError, notFound } from "../http/errors.ts";
import { normalizeEvents } from "./activity.ts";
import { type Ctx, inTx, now, type Scoped } from "./context.ts";
import {
  exceptionsOf,
  type MeetingRow,
  meetingRow,
  parseFilter,
  segmentOn,
  segmentsOf,
} from "./meeting-data.ts";
import { insertNote, noteSummaries } from "./notes.ts";
import { owned } from "./owned.ts";
import { projectRefs } from "./projects.ts";
import { chunks } from "./sql.ts";
import { plainText } from "./text.ts";

/**
 * The standup list: what the user has not said yet, worked out from the todos' activity after the
 * meeting's window start (since). A said or dismissed mark covers a todo's activity up to the time the
 * list showed; newer qualifying activity brings it back. Marks are kept per standup.
 *
 * - done: done after the cutoff (later comments do not bring it back).
 * - blocked: an update or comment after the cutoff.
 * - in progress: "started" when it moved to in progress after the cutoff, else "updated" when it has an
 *   update or comment after it. A todo in progress that this standup never marked is always on the
 *   list (the first standup shows everything in progress), as "started" when nothing else is new.
 * - open todos never are.
 */

const MAX_CHANGES = 5;
const EXCERPT = 200;
const UPDATE_KINDS: readonly string[] = STANDUP_UPDATE_KINDS;

interface Candidate {
  id: number;
  title: string;
  status: TodoRef["status"];
  projectId: number | null;
  parentId: number | null;
  doneAt: string | null;
  lastActivityAt: string;
}

interface Mark {
  coveredUntil: string;
}

const later = (a: string, b: string | undefined): string => (b !== undefined && b > a ? b : a);

function onlyStandups(meeting: MeetingRow): void {
  if (meeting.type !== "standup")
    throw new ApiError("conflict", "Only standups have a list. Change the meeting's type to Standup first.");
}

interface Listed extends Candidate {
  labelIds: ReadonlySet<number>;
}

/**
 * Todos that can be on a list: in progress, or blocked or done with activity after `since` (the
 * earliest window of the lists asked for), with their label ids when a filter needs them.
 */
function candidates(sc: Scoped, since: string, withLabels: boolean): Listed[] {
  const rows = sc.db
    .select({
      id: todos.id,
      title: todos.title,
      status: todos.status,
      projectId: todos.projectId,
      parentId: todos.parentId,
      doneAt: todos.doneAt,
      lastActivityAt: todos.lastActivityAt,
    })
    .from(todos)
    .where(
      owned(
        sc,
        todos,
        or(
          eq(todos.status, "in_progress"),
          and(inArray(todos.status, ["blocked", "done"]), gt(todos.lastActivityAt, since)),
        ),
      ),
    )
    .all();
  const labels = new Map<number, Set<number>>();
  if (withLabels) {
    for (const part of chunks(rows.map((r) => r.id))) {
      for (const link of sc.db
        .select({ todoId: todoLabels.todoId, labelId: todoLabels.labelId })
        .from(todoLabels)
        .where(owned(sc, todoLabels, inArray(todoLabels.todoId, part)))
        .all()) {
        const set = labels.get(link.todoId) ?? new Set<number>();
        set.add(link.labelId);
        labels.set(link.todoId, set);
      }
    }
  }
  return rows.map((r) => Object.assign(r, { labelIds: labels.get(r.id) ?? new Set<number>() }));
}

/** In one of the projects (or the Inbox when asked) and with any one of the labels; empty lists = no limit. */
function inFilter(todo: Listed, filter: StandupFilter): boolean {
  if (filter.projectIds.length > 0 || filter.inbox) {
    const inProject = todo.projectId !== null && filter.projectIds.includes(todo.projectId);
    if (!inProject && !(filter.inbox && todo.projectId === null)) return false;
  }
  return filter.labelIds.length === 0 || filter.labelIds.some((id) => todo.labelIds.has(id));
}

const markKey = (meetingId: number, todoId: number) => `${meetingId}|${todoId}`;

/** The newest covered time per standup and todo. */
function marksOf(sc: Scoped, meetingIds: readonly number[], todoIds: readonly number[]): Map<string, Mark> {
  const out = new Map<string, Mark>();
  for (const part of chunks(todoIds)) {
    for (const row of sc.db
      .select({
        meetingId: standupMarks.meetingId,
        todoId: standupMarks.todoId,
        coveredUntil: sql<string>`max(${standupMarks.coveredUntil})`,
      })
      .from(standupMarks)
      .where(
        owned(
          sc,
          standupMarks,
          inArray(standupMarks.meetingId, [...meetingIds]),
          inArray(standupMarks.todoId, part),
        ),
      )
      .groupBy(standupMarks.meetingId, standupMarks.todoId)
      .all()) {
      out.set(markKey(row.meetingId, row.todoId), { coveredUntil: row.coveredUntil });
    }
  }
  return out;
}

const groupBy = <T extends { todoId: number | null }>(rows: readonly T[]): Map<number, T[]> => {
  const out = new Map<number, T[]>();
  for (const row of rows) {
    const list = out.get(row.todoId as number) ?? [];
    list.push(row);
    out.set(row.todoId as number, list);
  }
  return out;
};

/** The newest move to in progress per todo, at any time. */
function lastStarts(sc: Scoped, todoIds: readonly number[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const part of chunks(todoIds)) {
    for (const row of sc.db
      .select({ todoId: events.todoId, at: sql<string>`max(${events.createdAt})` })
      .from(events)
      .where(
        owned(
          sc,
          events,
          inArray(events.todoId, part),
          eq(events.kind, "status_changed"),
          sql`json_extract(${events.data}, '$.to') = 'in_progress'`,
        ),
      )
      .groupBy(events.todoId)
      .all()) {
      out.set(row.todoId as number, row.at);
    }
  }
  return out;
}

const order = (kind: StandupKind): number => STANDUP_KINDS.indexOf(kind);

const isStart = (data: Record<string, unknown>): boolean => data.to === "in_progress";

type CommentRow = { todoId: number; actor: string; bodyMd: string; createdAt: string; id: number };

/** Events (update kinds only) and comments of the todos after `since`, newest first. */
function activityOf(sc: Scoped, ids: readonly number[], since: string) {
  const eventRows: (typeof events.$inferSelect)[] = [];
  const commentRows: CommentRow[] = [];
  for (const part of chunks(ids)) {
    eventRows.push(
      ...sc.db
        .select()
        .from(events)
        .where(
          owned(
            sc,
            events,
            inArray(events.todoId, part),
            gt(events.createdAt, since),
            inArray(events.kind, [...UPDATE_KINDS]),
          ),
        )
        .orderBy(desc(events.createdAt), desc(events.id))
        .all(),
    );
    commentRows.push(
      ...sc.db
        .select({
          id: comments.id,
          todoId: comments.todoId,
          actor: comments.actor,
          bodyMd: comments.bodyMd,
          createdAt: comments.createdAt,
        })
        .from(comments)
        .where(owned(sc, comments, inArray(comments.todoId, part), gt(comments.createdAt, since)))
        .orderBy(desc(comments.createdAt), desc(comments.id))
        .all(),
    );
  }
  return { events: groupBy(normalizeEvents(eventRows, sc)), comments: groupBy(commentRows) };
}

interface Found {
  todo: Candidate;
  kind: StandupKind;
  at: string;
  changes: string[];
  comments: CommentRow[];
  again: boolean;
}

/**
 * The lists of several standups at once (the meetings list counts all of them): the todos, their marks,
 * history and comments are read once for all, then each standup takes its window, filter and marks.
 * Every item by group and newest first.
 */
export function standupLists(sc: Scoped, meetings: readonly MeetingRow[]): Map<number, StandupItem[]> {
  const out = new Map<number, StandupItem[]>();
  if (meetings.length === 0) return out;
  const filters = new Map(meetings.map((m) => [m.id, parseFilter(m.filter)]));
  const earliest = meetings.reduce((min, m) => (m.since < min ? m.since : min), meetings[0]?.since ?? "");
  const all = candidates(
    sc,
    earliest,
    [...filters.values()].some((f) => f.labelIds.length > 0),
  );
  const marks = marksOf(
    sc,
    meetings.map((m) => m.id),
    all.map((t) => t.id),
  );
  const cutoffOf = (meeting: MeetingRow, id: number) =>
    later(meeting.since, marks.get(markKey(meeting.id, id))?.coveredUntil);
  // Per standup, the todos with something after their cutoff (or never marked and in progress).
  const open = new Map(
    meetings.map((meeting) => {
      const filter = filters.get(meeting.id) as StandupFilter;
      return [
        meeting.id,
        all.filter(
          (t) =>
            inFilter(t, filter) &&
            (t.lastActivityAt > cutoffOf(meeting, t.id) ||
              (t.status === "in_progress" && !marks.has(markKey(meeting.id, t.id)))),
        ),
      ];
    }),
  );
  const openIds = [...new Set([...open.values()].flatMap((list) => list.map((t) => t.id)))];
  const activity = activityOf(sc, openIds, earliest);
  const starts = lastStarts(sc, [
    ...new Set(
      meetings.flatMap((m) =>
        (open.get(m.id) ?? [])
          .filter((t) => t.status === "in_progress" && !marks.has(markKey(m.id, t.id)))
          .map((t) => t.id),
      ),
    ),
  ]);

  const found = new Map<number, Found[]>();
  for (const meeting of meetings) {
    const list: Found[] = [];
    for (const todo of open.get(meeting.id) ?? []) {
      const from = cutoffOf(meeting, todo.id);
      const marked = marks.has(markKey(meeting.id, todo.id));
      const evs = (activity.events.get(todo.id) ?? []).filter((e) => e.createdAt > from);
      const cms = (activity.comments.get(todo.id) ?? []).filter((c) => c.createdAt > from);
      const newest = later(evs[0]?.createdAt ?? "", cms[0]?.createdAt);
      let kind: StandupKind | null = null;
      let at = newest;
      if (todo.status === "done") {
        if (todo.doneAt !== null && todo.doneAt > from) {
          kind = "done";
          at = todo.doneAt;
        }
      } else if (todo.status === "blocked") {
        if (newest !== "") kind = "blocked";
      } else if (todo.status === "in_progress") {
        if (evs.some((e) => e.kind === "status_changed" && isStart(e.data))) kind = "started";
        else if (newest !== "") kind = "updated";
        else if (!marked) {
          kind = "started";
          at = starts.get(todo.id) ?? todo.lastActivityAt;
        }
      }
      if (kind === null) continue;
      list.push({
        todo,
        kind,
        at,
        changes: evs.slice(0, MAX_CHANGES).map((e) => describeEvent(e)),
        comments: cms,
        again: marked,
      });
    }
    found.set(meeting.id, list);
  }

  const every = [...found.values()].flat();
  const projects = projectRefs(
    sc,
    every.map((f) => f.todo.projectId),
  );
  const parents = todoBriefs(
    sc,
    every.flatMap((f) => (f.todo.parentId === null ? [] : [f.todo.parentId])),
  );
  for (const [meetingId, list] of found) {
    out.set(
      meetingId,
      list
        .toSorted(
          (a, b) => order(a.kind) - order(b.kind) || b.at.localeCompare(a.at) || b.todo.id - a.todo.id,
        )
        .map(({ todo, kind, at, changes, comments: cms, again }) => {
          const last = cms[0];
          return {
            todo: { id: todo.id, title: todo.title, status: todo.status },
            project: todo.projectId === null ? null : (projects.get(todo.projectId) ?? null),
            parent: todo.parentId === null ? null : (parents.get(todo.parentId)?.ref ?? null),
            kind,
            at,
            changes,
            newCommentCount: cms.length,
            lastComment: last
              ? {
                  actor: last.actor,
                  excerpt: plainText(last.bodyMd).slice(0, EXCERPT),
                  createdAt: last.createdAt,
                }
              : null,
            again,
          };
        }),
    );
  }
  return out;
}

/** Every item of one standup's list. */
export const standupItems = (sc: Scoped, meeting: MeetingRow): StandupItem[] =>
  standupLists(sc, [meeting]).get(meeting.id) ?? [];

/** The account's todos with these ids as refs, with their project. */
function todoBriefs(
  sc: Scoped,
  ids: readonly number[],
): Map<number, { ref: TodoRef; projectId: number | null }> {
  const out = new Map<number, { ref: TodoRef; projectId: number | null }>();
  for (const part of chunks([...new Set(ids)])) {
    for (const t of sc.db
      .select({ id: todos.id, title: todos.title, status: todos.status, projectId: todos.projectId })
      .from(todos)
      .where(owned(sc, todos, inArray(todos.id, part)))
      .all()) {
      out.set(t.id, { ref: { id: t.id, title: t.title, status: t.status }, projectId: t.projectId });
    }
  }
  return out;
}

/** Items still to say per standup, for the meetings list. */
export function openStandupCounts(sc: Scoped, meetings: readonly MeetingRow[]): Map<number, number> {
  const standups = meetings.filter((m) => m.type === "standup");
  return new Map([...standupLists(sc, standups)].map(([id, items]) => [id, items.length]));
}

/** The next meeting date on or after today (cancelled ones skipped), else today. */
function defaultDate(ctx: Ctx, sc: Scoped, meeting: MeetingRow): string {
  const segments = segmentsOf(sc, [meeting.id]).get(meeting.id) ?? [];
  const today = toLocalDate(ctx.clock(), ctx.timeZone);
  const next = nextSeriesOccurrence(
    segments,
    exceptionsOf(
      sc,
      segments.map((s) => s.id),
    ),
    startOfLocalDay(today, ctx.timeZone),
    ctx.timeZone,
  );
  return next?.occursOn ?? today;
}

function standupOf(sc: Scoped, meeting: MeetingRow, on: string, kinds?: readonly StandupKind[]): Standup {
  const items = standupItems(sc, meeting);
  const counts: StandupCounts = { done: 0, started: 0, updated: 0, blocked: 0 };
  for (const item of items) counts[item.kind] += 1;
  const marked = sc.db
    .select()
    .from(standupMarks)
    .where(owned(sc, standupMarks, eq(standupMarks.meetingId, meeting.id), eq(standupMarks.occursOn, on)))
    .orderBy(desc(standupMarks.markedAt), desc(standupMarks.todoId))
    .all();
  const saidRows = marked.filter((m) => m.kind === "said");
  const briefs = todoBriefs(
    sc,
    saidRows.map((m) => m.todoId),
  );
  const projects = projectRefs(
    sc,
    [...briefs.values()].map((b) => b.projectId),
  );
  const said: SaidItem[] = saidRows.flatMap((m) => {
    const brief = briefs.get(m.todoId);
    if (!brief) return [];
    return [
      {
        todo: brief.ref,
        project: brief.projectId === null ? null : (projects.get(brief.projectId) ?? null),
        markedAt: m.markedAt,
      },
    ];
  });
  return {
    meetingId: meeting.id,
    on,
    since: meeting.since,
    items: kinds && kinds.length > 0 ? items.filter((i) => kinds.includes(i.kind)) : items,
    counts,
    said,
    dismissedCount: marked.length - saidRows.length,
  };
}

export function getStandup(ctx: Ctx, id: number, query: StandupQuery): Standup {
  const meeting = meetingRow(ctx, id);
  onlyStandups(meeting);
  return standupOf(ctx, meeting, query.on ?? defaultDate(ctx, ctx, meeting), query.kind);
}

/** Checks that the date is one of the meeting's dates (404 otherwise). */
function assertDate(sc: Scoped, meeting: MeetingRow, on: string): void {
  segmentOn(meeting.id, segmentsOf(sc, [meeting.id]).get(meeting.id) ?? [], on);
}

/**
 * Marks todos as said or dismissed at a meeting date. Each mark covers the todo's activity up to the
 * time the list showed (clamped to the window and to now), so newer activity brings it back.
 */
export function markStandup(ctx: Ctx, id: number, input: MarkInput): Standup {
  return ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    const meeting = meetingRow(sc, id);
    onlyStandups(meeting);
    assertDate(sc, meeting, input.on);
    const ids = input.marks.map((m) => m.todoId);
    const known = todoBriefs(sc, ids);
    const missing = ids.find((todoId) => !known.has(todoId));
    if (missing !== undefined) throw notFound("Todo", missing);
    const at = now(ctx);
    for (const mark of input.marks) {
      const coveredUntil = later(meeting.since, mark.coveredUntil < at ? mark.coveredUntil : at);
      sc.db
        .insert(standupMarks)
        .values({
          accountId: sc.accountId,
          meetingId: id,
          todoId: mark.todoId,
          occursOn: input.on,
          kind: mark.kind,
          coveredUntil,
          markedAt: at,
        })
        .onConflictDoUpdate({
          target: [
            standupMarks.accountId,
            standupMarks.meetingId,
            standupMarks.todoId,
            standupMarks.occursOn,
          ],
          set: { kind: mark.kind, coveredUntil, markedAt: at },
        })
        .run();
    }
    return standupOf(sc, meeting, input.on);
  });
}

/** Undoes a said or dismissed mark. */
export function unmarkStandup(ctx: Ctx, id: number, on: string, todoId: number): void {
  ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    meetingRow(sc, id);
    const result = sc.db
      .delete(standupMarks)
      .where(
        owned(
          sc,
          standupMarks,
          eq(standupMarks.meetingId, id),
          eq(standupMarks.occursOn, on),
          eq(standupMarks.todoId, todoId),
        ),
      )
      .run();
    if (result.changes === 0)
      throw new ApiError(
        "not_found",
        `Todo ${todoId} has no mark on ${formatDate(on)}. Check the date and id.`,
      );
  });
}

// ---------- a note per meeting date ----------

function toMeetingNotes(sc: Scoped, rows: readonly (typeof meetingNotes.$inferSelect)[]): MeetingNote[] {
  const summaries = noteSummaries(
    sc,
    rows.map((r) => r.noteId),
  );
  return rows.flatMap((r) => {
    const note = summaries.get(r.noteId);
    return note ? [{ meetingId: r.meetingId, on: r.occursOn, note }] : [];
  });
}

/** The meeting's notes, newest date first (also of dates the repeat no longer has). */
export function listMeetingNotes(sc: Scoped, id: number): MeetingNote[] {
  meetingRow(sc, id);
  return toMeetingNotes(
    sc,
    sc.db
      .select()
      .from(meetingNotes)
      .where(owned(sc, meetingNotes, eq(meetingNotes.meetingId, id)))
      .orderBy(desc(meetingNotes.occursOn))
      .all(),
  );
}

/** Links a note to a meeting date, or writes a new one ("Standup 19.11.2026") when no note is given. */
export function addMeetingNote(ctx: Ctx, actor: string, id: number, input: MeetingNoteInput): MeetingNote {
  return ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    const meeting = meetingRow(sc, id);
    assertDate(sc, meeting, input.on);
    const taken = sc.db
      .select()
      .from(meetingNotes)
      .where(owned(sc, meetingNotes, eq(meetingNotes.meetingId, id), eq(meetingNotes.occursOn, input.on)))
      .get();
    if (taken)
      throw new ApiError("conflict", `${formatDate(input.on)} has a note already (note ${taken.noteId}).`);
    const at = now(ctx);
    let noteId = input.noteId;
    if (noteId === undefined) {
      noteId = insertNote(sc, actor, at, { title: `${meeting.name} ${formatDate(input.on)}`.slice(0, 200) });
    } else {
      if (!noteSummaries(sc, [noteId]).has(noteId)) throw notFound("Note", noteId);
      const used = sc.db
        .select()
        .from(meetingNotes)
        .where(owned(sc, meetingNotes, eq(meetingNotes.noteId, noteId)))
        .get();
      if (used) {
        const other = meetingRow(sc, used.meetingId);
        throw new ApiError(
          "conflict",
          `Note ${noteId} belongs to ${other.name} on ${formatDate(used.occursOn)} already.`,
        );
      }
    }
    sc.db
      .insert(meetingNotes)
      .values({ accountId: sc.accountId, meetingId: id, occursOn: input.on, noteId, createdAt: at })
      .run();
    const row = sc.db
      .select()
      .from(meetingNotes)
      .where(owned(sc, meetingNotes, eq(meetingNotes.meetingId, id), eq(meetingNotes.occursOn, input.on)))
      .get() as typeof meetingNotes.$inferSelect;
    return toMeetingNotes(sc, [row])[0] as MeetingNote;
  });
}

/** Unlinks the note of a date; the note stays. */
export function removeMeetingNote(ctx: Ctx, id: number, on: string): void {
  ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    meetingRow(sc, id);
    const result = sc.db
      .delete(meetingNotes)
      .where(owned(sc, meetingNotes, eq(meetingNotes.meetingId, id), eq(meetingNotes.occursOn, on)))
      .run();
    if (result.changes === 0)
      throw new ApiError("not_found", `Meeting ${id} has no note on ${formatDate(on)}. Check the date.`);
  });
}
