import {
  addDays,
  type CreateMeeting,
  dayShift,
  describeSeries,
  expandSeries,
  type ExpandedOccurrence,
  formatDate,
  isSeriesDate,
  lastStartBefore,
  type Meeting,
  type MeetingOccurrence,
  normalizeRecurrence,
  type OccurrenceChange,
  type OccurrenceQuery,
  previousRuleDate,
  type RecurrenceRule,
  type ScheduleChange,
  type Series,
  type SeriesException,
  type SeriesSpan,
  scheduledSpan,
  seriesProblem,
  shiftRule,
  StandupFilter,
  startOfLocalDay,
  suggestMeetingType,
  toLocalDate,
  toLocalTime,
  type UpdateMeeting,
  MAX_EXCEPTIONS,
  MAX_MEETINGS,
  MAX_SEGMENTS,
} from "@organizer/shared";
import { asc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { meetingNotes, meetings, series, seriesExceptions } from "../db/schema.ts";
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

/** A schedule rule normalized from its anchor, without until (endsOn is the only end). */
function scheduleRule(rule: RecurrenceRule, anchor: string): RecurrenceRule {
  const { until: _until, ...rest } = rule;
  return normalizeRecurrence(rest, anchor);
}

/** A segment must have a date, stay within 10 years and inside the years 1900 to 2999. */
function checkHasDates(span: Omit<SeriesSpan, "id">): void {
  const problem = seriesProblem(span);
  if (problem !== null) throw invalid(problem);
}

/** Segments, by first date, must not overlap. */
function checkNoOverlap(segments: readonly Omit<SeriesSpan, "id">[]): void {
  const sorted = segments.toSorted((a, b) => a.startsOn.localeCompare(b.startsOn));
  for (let i = 1; i < sorted.length; i += 1) {
    const before = sorted[i - 1] as Omit<SeriesSpan, "id">;
    const after = sorted[i] as Omit<SeriesSpan, "id">;
    if (before.endsOn === null || before.endsOn >= after.startsOn)
      throw invalid("This change would run into another part of the repeat. Change only this date instead.");
  }
}

const seriesValues = (span: Omit<SeriesSpan, "id">) => ({
  rule: JSON.stringify(span.rule),
  startsOn: span.startsOn,
  endsOn: span.endsOn,
  startTime: span.startTime,
  durationMin: span.durationMinutes,
});

const countOf = (
  sc: Scoped,
  table: typeof meetings | typeof series | typeof seriesExceptions,
  where: ReturnType<typeof owned>,
) => sc.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM ${table} WHERE ${where}`).n;

function insertSegment(sc: Scoped, meetingId: number, span: Omit<SeriesSpan, "id">, at: string): number {
  if (countOf(sc, series, owned(sc, series, eq(series.meetingId, meetingId))) >= MAX_SEGMENTS)
    throw invalid(
      `A meeting's repeat can have at most ${MAX_SEGMENTS} parts. Change all dates instead of this and following.`,
    );
  return insertOwnedRow(sc, series, {
    ownerKind: "meeting",
    meetingId,
    ...seriesValues(span),
    createdAt: at,
    updatedAt: at,
  });
}

function updateSegment(sc: Scoped, id: number, span: Omit<SeriesSpan, "id">, at: string): void {
  sc.db
    .update(series)
    .set({ ...seriesValues(span), updatedAt: at })
    .where(owned(sc, series, eq(series.id, id)))
    .run();
}

function deleteSegment(sc: Scoped, id: number): void {
  sc.db
    .delete(series)
    .where(owned(sc, series, eq(series.id, id)))
    .run();
}

const exceptionKey = (sc: Scoped, seriesId: number, on: string) =>
  owned(sc, seriesExceptions, eq(seriesExceptions.seriesId, seriesId), eq(seriesExceptions.occursOn, on));

/** Drops the single date changes of a segment from a date on. */
function dropExceptionsFrom(sc: Scoped, seriesId: number, from: string): void {
  sc.db
    .delete(seriesExceptions)
    .where(
      owned(
        sc,
        seriesExceptions,
        eq(seriesExceptions.seriesId, seriesId),
        gte(seriesExceptions.occursOn, from),
      ),
    )
    .run();
}

/** Replaces a segment's single date changes (keys can move, so delete and insert again). */
function replaceExceptions(sc: Scoped, seriesId: number, list: readonly SeriesException[], at: string): void {
  sc.db
    .delete(seriesExceptions)
    .where(owned(sc, seriesExceptions, eq(seriesExceptions.seriesId, seriesId)))
    .run();
  if (list.length === 0) return;
  sc.db
    .insert(seriesExceptions)
    .values(
      list.map((e) => ({
        accountId: sc.accountId,
        seriesId,
        occursOn: e.occursOn,
        kind: e.kind,
        startAt: e.startAt,
        endAt: e.endAt,
        createdAt: at,
        updatedAt: at,
      })),
    )
    .run();
}

function upsertException(sc: Scoped, e: SeriesException, at: string): void {
  const others = owned(
    sc,
    seriesExceptions,
    eq(seriesExceptions.seriesId, e.seriesId),
    ne(seriesExceptions.occursOn, e.occursOn),
  );
  if (countOf(sc, seriesExceptions, others) >= MAX_EXCEPTIONS)
    throw invalid(
      `A repeat can have at most ${MAX_EXCEPTIONS} moved or cancelled dates. Change the repeat itself instead.`,
    );
  sc.db
    .insert(seriesExceptions)
    .values({ accountId: sc.accountId, ...e, createdAt: at, updatedAt: at })
    .onConflictDoUpdate({
      target: [seriesExceptions.accountId, seriesExceptions.seriesId, seriesExceptions.occursOn],
      set: { kind: e.kind, startAt: e.startAt, endAt: e.endAt, updatedAt: at },
    })
    .run();
}

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
    insertSegment(sc, id, span, at);
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

interface Loaded {
  segments: SeriesSpan[];
  segment: SeriesSpan;
  exceptions: SeriesException[];
}

function load(sc: Scoped, meetingId: number, on: string): Loaded {
  meetingRow(sc, meetingId);
  const segments = segmentsOf(sc, [meetingId]).get(meetingId) ?? [];
  const segment = segmentOn(meetingId, segments, on);
  return { segments, segment, exceptions: exceptionsOf(sc, [segment.id]) };
}

const others = (segments: readonly SeriesSpan[], id: number) => segments.filter((s) => s.id !== id);
const nextAfter = (segments: readonly SeriesSpan[], segment: SeriesSpan) =>
  segments.find((s) => s.startsOn > segment.startsOn);
const without = ({ id: _id, ...span }: SeriesSpan): Omit<SeriesSpan, "id"> => span;

/** The last date of the segment before an original date, or null when that date is its first. */
function earlierDate(segment: SeriesSpan, on: string): string | null {
  const date = previousRuleDate(segment.rule, segment.startsOn, on);
  return date >= segment.startsOn ? date : null;
}

/** Ends a shifted or rewritten segment before the next one, when it ended before it already. */
function endBefore(endsOn: string | null, next: SeriesSpan | undefined, hadEnd: boolean): string | null {
  if (!next || !hadEnd) return endsOn;
  const last = addDays(next.startsOn, -1);
  return endsOn === null || endsOn > last ? last : endsOn;
}

/**
 * Changes the repeat from an original date on. "following" ends the segment the day before and starts
 * a new one there (its single date changes from that date on are dropped); "all" rewrites the segment
 * that holds the date and drops the single date changes the new rule no longer has.
 */
export function changeSchedule(ctx: Ctx, id: number, input: ScheduleChange): Meeting {
  return ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    const { segments, segment, exceptions } = load(sc, id, input.from);
    const at = now(ctx);
    const whole = input.scope === "all" || input.from === segment.startsOn;
    const startsOn = whole ? segment.startsOn : input.from;
    const endsOn = input.endsOn !== undefined ? input.endsOn : (input.rule?.until ?? segment.endsOn);
    const span: Omit<SeriesSpan, "id"> = {
      rule: input.rule ? scheduleRule(input.rule, startsOn) : segment.rule,
      startsOn,
      endsOn,
      startTime: input.startTime ?? segment.startTime,
      durationMinutes: input.durationMinutes ?? segment.durationMinutes,
    };
    checkHasDates(span);
    if (whole) {
      checkNoOverlap([...others(segments, segment.id).map(without), span]);
      updateSegment(sc, segment.id, span, at);
      replaceExceptions(
        sc,
        segment.id,
        exceptions.filter((e) => isSeriesDate(span, e.occursOn)),
        at,
      );
    } else {
      const head = { ...without(segment), endsOn: addDays(input.from, -1) };
      checkNoOverlap([...others(segments, segment.id).map(without), head, span]);
      updateSegment(sc, segment.id, head, at);
      dropExceptionsFrom(sc, segment.id, input.from);
      insertSegment(sc, id, span, at);
    }
    touchMeeting(sc, id, at);
    return getMeeting(ctx, id, sc);
  });
}

/** Moves the dates of a whole segment by some days and to a new time. */
function shiftSegment(
  sc: Scoped,
  loaded: Loaded,
  on: string,
  move: { delta: number; startTime: string; durationMinutes: number },
  at: string,
): void {
  const { segments, segment, exceptions } = loaded;
  const rule = shiftRule(segment.rule, move.delta);
  if (rule === null) throw invalid("Only this date can move to another day for this repeat.");
  const span = {
    rule,
    startsOn: addDays(segment.startsOn, move.delta),
    endsOn: endBefore(
      segment.endsOn === null ? null : addDays(segment.endsOn, move.delta),
      nextAfter(segments, segment),
      segment.endsOn !== null,
    ),
    startTime: move.startTime,
    durationMinutes: move.durationMinutes,
  };
  checkHasDates(span);
  checkNoOverlap([...others(segments, segment.id).map(without), span]);
  updateSegment(sc, segment.id, span, at);
  // The moved date now follows the series; the other single date changes move with their dates.
  replaceExceptions(
    sc,
    segment.id,
    exceptions
      .filter((e) => e.occursOn !== on)
      .map((e) => Object.assign({}, e, { occursOn: addDays(e.occursOn, move.delta) })),
    at,
  );
}

/** Ends the repeat before a date: the segment ends the day before, later segments are deleted. */
function cancelFollowing(sc: Scoped, loaded: Loaded, on: string, at: string): void {
  const { segments, segment } = loaded;
  const isFirst = segments[0]?.id === segment.id;
  const firstDate = earlierDate(segment, on) === null;
  if (firstDate && isFirst)
    throw invalid("This is the first date of the meeting. Delete the meeting to cancel every date.");
  for (const later of segments.filter((s) => s.startsOn > segment.startsOn)) deleteSegment(sc, later.id);
  if (firstDate) {
    deleteSegment(sc, segment.id);
    return;
  }
  updateSegment(sc, segment.id, { ...without(segment), endsOn: addDays(on, -1) }, at);
  dropExceptionsFrom(sc, segment.id, on);
}

/**
 * Changes one original date: move it (this one; this and following = a new segment from it on with the
 * rule shifted by the days moved; all = the segment that holds it), cancel it (this one; this and
 * following = the repeat ends the day before) or undo its single date change.
 */
export function changeOccurrence(ctx: Ctx, id: number, on: string, input: OccurrenceChange): Meeting {
  return ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    const loaded = load(sc, id, on);
    const { segment } = loaded;
    const at = now(ctx);
    if ("cancelled" in input) {
      if (!input.cancelled) {
        sc.db
          .delete(seriesExceptions)
          .where(exceptionKey(sc, segment.id, on))
          .run();
      } else if (input.scope === "this") {
        upsertException(
          sc,
          { seriesId: segment.id, occursOn: on, kind: "cancelled", startAt: null, endAt: null },
          at,
        );
      } else {
        cancelFollowing(sc, loaded, on, at);
      }
    } else {
      const move = {
        delta: dayShift(on, input.startAt, ctx.timeZone),
        startTime: toLocalTime(input.startAt, ctx.timeZone),
        durationMinutes: Math.round((Date.parse(input.endAt) - Date.parse(input.startAt)) / 60_000),
      };
      // "following" starts a new segment only after an earlier date; from the first date it is "all".
      const earlier = earlierDate(segment, on);
      if (input.scope === "this") {
        const planned = scheduledSpan(segment, on, ctx.timeZone);
        if (planned.startAt === input.startAt && planned.endAt === input.endAt) {
          sc.db
            .delete(seriesExceptions)
            .where(exceptionKey(sc, segment.id, on))
            .run();
        } else {
          upsertException(
            sc,
            { seriesId: segment.id, occursOn: on, kind: "moved", startAt: input.startAt, endAt: input.endAt },
            at,
          );
        }
      } else if (input.scope === "all" || earlier === null) {
        shiftSegment(sc, loaded, on, move, at);
      } else {
        const rule = shiftRule(segment.rule, move.delta);
        if (rule === null) throw invalid("Only this date can move to another day for this repeat.");
        const startsOn = addDays(on, move.delta);
        if (startsOn <= earlier)
          throw invalid(
            `This date cannot move to or before ${formatDate(earlier)}, an earlier date of the repeat. Move only this date instead.`,
          );
        const head = { ...without(segment), endsOn: addDays(startsOn < on ? startsOn : on, -1) };
        const tail = {
          rule,
          startsOn,
          endsOn: endBefore(
            segment.endsOn === null ? null : addDays(segment.endsOn, move.delta),
            nextAfter(loaded.segments, segment),
            segment.endsOn !== null,
          ),
          startTime: move.startTime,
          durationMinutes: move.durationMinutes,
        };
        checkHasDates(tail);
        checkNoOverlap([...others(loaded.segments, segment.id).map(without), head, tail]);
        updateSegment(sc, segment.id, head, at);
        dropExceptionsFrom(sc, segment.id, on);
        insertSegment(sc, id, tail, at);
      }
    }
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
