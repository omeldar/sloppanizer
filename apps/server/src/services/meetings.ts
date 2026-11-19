import {
  type CreateMeeting,
  describeSeries,
  expandSeries,
  type ExpandedOccurrence,
  formatDate,
  lastStartBefore,
  type Meeting,
  type MeetingOccurrence,
  type OccurrenceChange,
  type OccurrenceQuery,
  type ScheduleChange,
  type Series,
  type SeriesSpan,
  StandupFilter,
  startOfLocalDay,
  suggestMeetingType,
  toLocalDate,
  type UpdateMeeting,
  MAX_MEETINGS,
  MAX_SEGMENTS,
} from "@organizer/shared";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { meetingNotes, meetings } from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import { type Ctx, inTx, now, type Scoped } from "./context.ts";
import {
  checkedFilter,
  exceptionsOf,
  type MeetingRow,
  meetingRow,
  nextOf,
  parseFilter,
  segmentOn,
  segmentsOf,
} from "./meeting-data.ts";
import { insertOwnedRow, owned } from "./owned.ts";
import {
  changeDate,
  changeSpan,
  checkHasDates,
  insertSegment,
  type Loaded,
  loadSeries,
  type OwnerTexts,
  scheduleRule,
  type SeriesOwner,
} from "./series-editor.ts";
import { chunks } from "./sql.ts";
import { openStandupCounts } from "./standup.ts";

/**
 * Meetings and their repeat. A repeat is one or more series segments that never overlap; a change
 * "from this date on" ends the segment the day before and starts a new one. Single dates are moved or
 * cancelled through exceptions keyed by the original date, which is also the key of notes and marks.
 */

const toSeries = (span: SeriesSpan): Series => ({ ...span, text: describeSeries(span) });

const invalid = (message: string) => new ApiError("validation_failed", message);

/** The segment that holds today, else the next one, else the last one. */
function currentSegment(segments: readonly SeriesSpan[], today: string): SeriesSpan {
  return (
    segments.find((s) => s.startsOn <= today && (s.endsOn === null || s.endsOn >= today)) ??
    segments.find((s) => s.startsOn > today) ??
    (segments.at(-1) as SeriesSpan)
  );
}

/** Note ids by "meetingId|date". */
function noteLinks(sc: Scoped, meetingIds: readonly number[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of chunks(meetingIds)) {
    for (const row of sc.db
      .select()
      .from(meetingNotes)
      .where(owned(sc, meetingNotes, inArray(meetingNotes.meetingId, part)))
      .all()) {
      out.set(`${row.meetingId}|${row.occursOn}`, row.noteId);
    }
  }
  return out;
}

const toOccurrence = (
  meeting: MeetingRow,
  o: ExpandedOccurrence,
  notes: ReadonlyMap<string, number>,
): MeetingOccurrence => ({
  meetingId: meeting.id,
  seriesId: o.seriesId,
  name: meeting.name,
  type: meeting.type,
  occursOn: o.occursOn,
  startAt: o.startAt,
  endAt: o.endAt,
  status: o.status,
  noteId: notes.get(`${meeting.id}|${o.occursOn}`) ?? null,
});

/**
 * Meetings as the API answers them. `counts` works out each standup's list for openCount, which only
 * the meetings list needs: one meeting and change answers leave it null (its list is GET .../standup).
 */
function hydrate(ctx: Ctx, sc: Scoped, rows: readonly MeetingRow[], counts = false): Meeting[] {
  const ids = rows.map((r) => r.id);
  const segments = segmentsOf(sc, ids);
  const exceptions = exceptionsOf(
    sc,
    [...segments.values()].flatMap((list) => list.map((s) => s.id)),
  );
  const notes = noteLinks(sc, ids);
  const open = counts ? openStandupCounts(sc, rows) : new Map<number, number>();
  const at = ctx.clock();
  const today = toLocalDate(at, ctx.timeZone);
  return rows.flatMap((row) => {
    const list = segments.get(row.id) ?? [];
    if (list.length === 0) return [];
    const next = nextOf(list, exceptions, at, ctx.timeZone);
    return [
      {
        id: row.id,
        name: row.name,
        type: row.type,
        filter: parseFilter(row.filter),
        since: row.since,
        schedule: toSeries(currentSegment(list, today)),
        segments: list.map(toSeries),
        next: next === null ? null : toOccurrence(row, next, notes),
        openCount: counts && row.type === "standup" ? (open.get(row.id) ?? 0) : null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
    ];
  });
}

const byNext = (a: Meeting, b: Meeting): number => {
  if (a.next && b.next) return a.next.startAt.localeCompare(b.next.startAt) || a.id - b.id;
  if (a.next || b.next) return a.next ? -1 : 1;
  return a.name.localeCompare(b.name) || a.id - b.id;
};

/**
 * Every meeting, the next one first (meetings without a next date last, by name). A meeting without a
 * readable repeat (a hand-made restore) is left out.
 */
export function listMeetings(ctx: Ctx): Meeting[] {
  const rows = ctx.db.select().from(meetings).where(owned(ctx, meetings)).all();
  return hydrate(ctx, ctx, rows, true).toSorted(byNext);
}

export function getMeeting(ctx: Ctx, id: number, sc: Scoped = ctx): Meeting {
  const meeting = hydrate(ctx, sc, [meetingRow(sc, id)])[0];
  if (!meeting)
    throw new ApiError("conflict", `Meeting ${id} has no readable repeat. Delete it and create it again.`);
  return meeting;
}

const countOf = (sc: Scoped, table: typeof meetings, where: ReturnType<typeof owned>) =>
  sc.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM ${table} WHERE ${where}`).n;

const MEETING_TEXTS: OwnerTexts = {
  tooManyParts: `A meeting's repeat can have at most ${MAX_SEGMENTS} parts. Change all dates instead of this and following.`,
  cancelFirstDate: "This is the first date of the meeting. Delete the meeting to cancel every date.",
  noDate: (on) => `Meeting has no date on ${formatDate(on)}.`,
};

const meetingOwner = (id: number): SeriesOwner => ({ kind: "meeting", id });

function touchMeeting(sc: Scoped, id: number, at: string): void {
  sc.db
    .update(meetings)
    .set({ updatedAt: at })
    .where(owned(sc, meetings, eq(meetings.id, id)))
    .run();
}

export function createMeeting(ctx: Ctx, input: CreateMeeting): Meeting {
  return ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    const { schedule } = input;
    const span = {
      rule: scheduleRule(schedule.rule, schedule.startsOn),
      startsOn: schedule.startsOn,
      endsOn: schedule.endsOn ?? schedule.rule.until ?? null,
      startTime: schedule.startTime,
      durationMinutes: schedule.durationMinutes,
    };
    checkHasDates(span);
    if (countOf(sc, meetings, owned(sc, meetings)) >= MAX_MEETINGS)
      throw invalid(
        `An account can have at most ${MAX_MEETINGS} meetings. Delete one you no longer need first.`,
      );
    const filter = checkedFilter(sc, input.filter ?? StandupFilter.parse({}));
    const at = now(ctx);
    const since =
      input.countFrom === undefined
        ? lastStartBefore(span, ctx.clock(), ctx.timeZone)
        : startOfLocalDay(input.countFrom, ctx.timeZone).toISOString();
    const id = insertOwnedRow(sc, meetings, {
      name: input.name,
      type: input.type ?? suggestMeetingType(input.name),
      filter: JSON.stringify(filter),
      since,
      createdAt: at,
      updatedAt: at,
    });
    insertSegment(sc, meetingOwner(id), span, at, MEETING_TEXTS);
    return getMeeting(ctx, id, sc);
  });
}

export function updateMeeting(ctx: Ctx, id: number, input: UpdateMeeting): Meeting {
  return ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    meetingRow(sc, id);
    const patch: Partial<MeetingRow> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.type !== undefined) patch.type = input.type;
    if (input.filter !== undefined) patch.filter = JSON.stringify(checkedFilter(sc, input.filter));
    if (input.countFrom !== undefined)
      patch.since = startOfLocalDay(input.countFrom, ctx.timeZone).toISOString();
    sc.db
      .update(meetings)
      .set({ ...patch, updatedAt: now(ctx) })
      .where(owned(sc, meetings, eq(meetings.id, id)))
      .run();
    return getMeeting(ctx, id, sc);
  });
}

/** Deletes the meeting with its repeat, single date changes, marks and note links; the notes stay. */
export function deleteMeeting(ctx: Ctx, id: number): void {
  ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    meetingRow(sc, id);
    sc.db
      .delete(meetings)
      .where(owned(sc, meetings, eq(meetings.id, id)))
      .run();
  });
}

function load(sc: Scoped, meetingId: number, on: string): Loaded {
  meetingRow(sc, meetingId);
  const segments = segmentsOf(sc, [meetingId]).get(meetingId) ?? [];
  // The 404 names the meeting (segmentOn), like before the editor was shared.
  segmentOn(meetingId, segments, on);
  return loadSeries(sc, meetingOwner(meetingId), on, MEETING_TEXTS, segments);
}

/**
 * Changes the repeat from an original date on. "following" ends the segment the day before and starts
 * a new one there (its single date changes from that date on are dropped); "all" rewrites the segment
 * that holds the date and drops the single date changes the new rule no longer has.
 */
export function changeSchedule(ctx: Ctx, id: number, input: ScheduleChange): Meeting {
  return ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    const at = now(ctx);
    changeSpan(sc, load(sc, id, input.from), input, at);
    touchMeeting(sc, id, at);
    return getMeeting(ctx, id, sc);
  });
}

/**
 * Changes one original date: move it (this one; this and following = a new segment from it on with the
 * rule shifted by the days moved; all = the segment that holds it), cancel it (this one; this and
 * following = the repeat ends the day before) or undo its single date change.
 */
export function changeOccurrence(ctx: Ctx, id: number, on: string, input: OccurrenceChange): Meeting {
  return ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    const at = now(ctx);
    changeDate(sc, load(sc, id, on), on, input, ctx.timeZone, at);
    touchMeeting(sc, id, at);
    return getMeeting(ctx, id, sc);
  });
}

/** Occurrences of every meeting (or one) that overlap the days from..to, by start. */
export function listOccurrences(ctx: Ctx, query: OccurrenceQuery): MeetingOccurrence[] {
  const rows =
    query.meetingId === undefined
      ? ctx.db.select().from(meetings).where(owned(ctx, meetings)).orderBy(asc(meetings.id)).all()
      : [meetingRow(ctx, query.meetingId)];
  const ids = rows.map((r) => r.id);
  const segments = segmentsOf(ctx, ids);
  const exceptions = exceptionsOf(
    ctx,
    [...segments.values()].flatMap((list) => list.map((s) => s.id)),
  );
  const notes = noteLinks(ctx, ids);
  const out: MeetingOccurrence[] = [];
  for (const row of rows) {
    const list = segments.get(row.id) ?? [];
    for (const o of expandSeries(list, exceptions, query.from, query.to, ctx.timeZone)) {
      if (o.status === "cancelled" && query.cancelled !== true) continue;
      out.push(toOccurrence(row, o, notes));
    }
  }
  return out.toSorted((a, b) => a.startAt.localeCompare(b.startAt) || a.meetingId - b.meetingId);
}
