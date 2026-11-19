import {
  addDays,
  dayShift,
  formatDate,
  isCalendarDate,
  isSeriesDate,
  normalizeRecurrence,
  previousRuleDate,
  type RecurrenceRule,
  type SeriesException,
  SeriesRule,
  type SeriesScope,
  type SeriesSpan,
  scheduledSpan,
  seriesProblem,
  shiftRule,
  TimeOfDay,
  Timestamp,
  toLocalTime,
  MAX_EXCEPTIONS,
  MAX_SEGMENTS,
} from "@organizer/shared";
import { asc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { series, seriesExceptions } from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import type { Scoped } from "./context.ts";
import { insertOwnedRow, owned } from "./owned.ts";
import { chunks } from "./sql.ts";

/**
 * Repeats on a schedule, for any owner: a meeting, or the planned time of a repeating todo. A repeat is
 * one or more series segments that never overlap; a change "from this date on" ends the segment the day
 * before and starts a new one. Single dates are moved or cancelled through exceptions keyed by the
 * original date. The owner's service checks the owner exists and words the answers through OwnerTexts.
 */

export type SeriesOwner = { kind: "meeting"; id: number } | { kind: "todo"; id: number };

/** How the answers name the owner. */
export interface OwnerTexts {
  /** 422 when a "this and following" change would add a part over MAX_SEGMENTS. */
  tooManyParts: string;
  /** 422 when "this and following" is cancelled from the very first date. */
  cancelFirstDate: string;
  /** 404 when the owner has no date on `on`. */
  noDate: (on: string) => string;
}

const invalid = (message: string) => new ApiError("validation_failed", message);

const ownerColumn = (kind: SeriesOwner["kind"]) => (kind === "meeting" ? series.meetingId : series.todoId);

// ---------- reading ----------

/**
 * A stored segment, or null when it cannot be used (only a hand-made restore can store one): a schedule
 * rule without until, calendar dates within the series limits, an HH:MM time and 5 to 1440 minutes.
 */
export function readSpan(row: {
  id: number;
  rule: string;
  startsOn: string;
  endsOn: string | null;
  startTime: string;
  durationMin: number;
}): SeriesSpan | null {
  let json: unknown;
  try {
    json = JSON.parse(row.rule);
  } catch {
    return null;
  }
  const rule = SeriesRule.safeParse(json);
  if (!rule.success || rule.data.until !== undefined) return null;
  if (!isCalendarDate(row.startsOn) || (row.endsOn !== null && !isCalendarDate(row.endsOn))) return null;
  if (!TimeOfDay.safeParse(row.startTime).success) return null;
  if (!Number.isInteger(row.durationMin) || row.durationMin < 5 || row.durationMin > 1440) return null;
  const span: SeriesSpan = {
    id: row.id,
    rule: rule.data,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    startTime: row.startTime,
    durationMinutes: row.durationMin,
  };
  return seriesProblem(span) === null ? span : null;
}

/** The segments of each owner of a kind, by first date; unreadable ones are left out. */
export function segmentsOfOwners(
  sc: Scoped,
  kind: SeriesOwner["kind"],
  ownerIds: readonly number[],
): Map<number, SeriesSpan[]> {
  const out = new Map<number, SeriesSpan[]>(ownerIds.map((id) => [id, []]));
  const column = ownerColumn(kind);
  for (const part of chunks(ownerIds)) {
    const rows = sc.db
      .select()
      .from(series)
      .where(owned(sc, series, eq(series.ownerKind, kind), inArray(column, part)))
      .orderBy(asc(series.startsOn), asc(series.id))
      .all();
    for (const row of rows) {
      const span = readSpan(row);
      const owner = kind === "meeting" ? row.meetingId : row.todoId;
      if (span && owner !== null) out.get(owner)?.push(span);
    }
  }
  return out;
}

const isInstant = (value: string | null): value is string =>
  value !== null && Timestamp.safeParse(value).success;

/** Every single date change of the segments (a few per repeat and year). */
export function exceptionsOf(sc: Scoped, seriesIds: readonly number[]): SeriesException[] {
  const out: SeriesException[] = [];
  for (const part of chunks(seriesIds)) {
    for (const row of sc.db
      .select()
      .from(seriesExceptions)
      .where(owned(sc, seriesExceptions, inArray(seriesExceptions.seriesId, part)))
      .all()) {
      // Unreadable rows (a hand-made restore) are left out instead of failing every list.
      if (!isCalendarDate(row.occursOn)) continue;
      if (row.kind === "moved" && (!isInstant(row.startAt) || !isInstant(row.endAt))) continue;
      out.push({
        seriesId: row.seriesId,
        occursOn: row.occursOn,
        kind: row.kind,
        startAt: row.startAt,
        endAt: row.endAt,
      });
    }
  }
  return out;
}

// ---------- checks ----------

/** A schedule rule normalized from its anchor, without until (endsOn is the only end). */
export function scheduleRule(rule: RecurrenceRule, anchor: string): RecurrenceRule {
  const { until: _until, ...rest } = rule;
  return normalizeRecurrence(rest, anchor);
}

/** A segment must have a date, stay within 10 years and inside the years 1900 to 2999. */
export function checkHasDates(span: Omit<SeriesSpan, "id">): void {
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

// ---------- writing ----------

const seriesValues = (span: Omit<SeriesSpan, "id">) => ({
  rule: JSON.stringify(span.rule),
  startsOn: span.startsOn,
  endsOn: span.endsOn,
  startTime: span.startTime,
  durationMin: span.durationMinutes,
});

const countOf = (
  sc: Scoped,
  table: typeof series | typeof seriesExceptions,
  where: ReturnType<typeof owned>,
) => sc.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM ${table} WHERE ${where}`).n;

export function insertSegment(
  sc: Scoped,
  owner: SeriesOwner,
  span: Omit<SeriesSpan, "id">,
  at: string,
  texts: OwnerTexts,
): number {
  const column = ownerColumn(owner.kind);
  if (
    countOf(sc, series, owned(sc, series, eq(series.ownerKind, owner.kind), eq(column, owner.id))) >=
    MAX_SEGMENTS
  )
    throw invalid(texts.tooManyParts);
  return insertOwnedRow(sc, series, {
    ownerKind: owner.kind,
    meetingId: owner.kind === "meeting" ? owner.id : null,
    todoId: owner.kind === "todo" ? owner.id : null,
    ...seriesValues(span),
    createdAt: at,
    updatedAt: at,
  });
}

export function updateSegment(sc: Scoped, id: number, span: Omit<SeriesSpan, "id">, at: string): void {
  sc.db
    .update(series)
    .set({ ...seriesValues(span), updatedAt: at })
    .where(owned(sc, series, eq(series.id, id)))
    .run();
}

export function deleteSegment(sc: Scoped, id: number): void {
  sc.db
    .delete(series)
    .where(owned(sc, series, eq(series.id, id)))
    .run();
}

const exceptionKey = (sc: Scoped, seriesId: number, on: string) =>
  owned(sc, seriesExceptions, eq(seriesExceptions.seriesId, seriesId), eq(seriesExceptions.occursOn, on));

/** Drops the single date changes of a segment from a date on. */
export function dropExceptionsFrom(sc: Scoped, seriesId: number, from: string): void {
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

// ---------- changes ----------

export interface Loaded {
  owner: SeriesOwner;
  texts: OwnerTexts;
  segments: SeriesSpan[];
  segment: SeriesSpan;
  exceptions: SeriesException[];
}

/** The owner's segments and the one that holds `on`; 404 when no segment has that date. */
export function loadSeries(
  sc: Scoped,
  owner: SeriesOwner,
  on: string,
  texts: OwnerTexts,
  segments: SeriesSpan[] = segmentsOfOwners(sc, owner.kind, [owner.id]).get(owner.id) ?? [],
): Loaded {
  const segment = segments.find((s) => isSeriesDate(s, on));
  if (!segment) throw new ApiError("not_found", texts.noDate(on));
  return { owner, texts, segments, segment, exceptions: exceptionsOf(sc, [segment.id]) };
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

/** A change of the repeat from an original date on (the fields left out stay). */
export interface SpanChange {
  scope: "following" | "all";
  from: string;
  rule?: RecurrenceRule | undefined;
  startTime?: string | undefined;
  durationMinutes?: number | undefined;
  endsOn?: string | null | undefined;
}

/**
 * Changes the repeat from an original date on. "following" ends the segment the day before and starts
 * a new one there (its single date changes from that date on are dropped); "all" rewrites the segment
 * that holds the date and drops the single date changes the new rule no longer has.
 */
export function changeSpan(sc: Scoped, loaded: Loaded, input: SpanChange, at: string): void {
  const { segments, segment, exceptions } = loaded;
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
    insertSegment(sc, loaded.owner, span, at, loaded.texts);
  }
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
export function cancelFollowing(sc: Scoped, loaded: Loaded, on: string, at: string): void {
  const { segments, segment } = loaded;
  const isFirst = segments[0]?.id === segment.id;
  const firstDate = earlierDate(segment, on) === null;
  if (firstDate && isFirst) throw invalid(loaded.texts.cancelFirstDate);
  for (const later of segments.filter((s) => s.startsOn > segment.startsOn)) deleteSegment(sc, later.id);
  if (firstDate) {
    deleteSegment(sc, segment.id);
    return;
  }
  updateSegment(sc, segment.id, { ...without(segment), endsOn: addDays(on, -1) }, at);
  dropExceptionsFrom(sc, segment.id, on);
}

/** A change of one original date (the shape of OccurrenceChange in the contract). */
export type DateChange =
  | { scope: SeriesScope; startAt: string; endAt: string }
  | { scope: "this" | "following"; cancelled: true }
  | { scope: "this"; cancelled: false };

/**
 * Changes one original date: move it (this one; this and following = a new segment from it on with the
 * rule shifted by the days moved; all = the segment that holds it), cancel it (this one; this and
 * following = the repeat ends the day before) or undo its single date change.
 */
export function changeDate(
  sc: Scoped,
  loaded: Loaded,
  on: string,
  input: DateChange,
  timeZone: string,
  at: string,
): void {
  const { segment } = loaded;
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
    return;
  }
  const move = {
    delta: dayShift(on, input.startAt, timeZone),
    startTime: toLocalTime(input.startAt, timeZone),
    durationMinutes: Math.round((Date.parse(input.endAt) - Date.parse(input.startAt)) / 60_000),
  };
  // "following" starts a new segment only after an earlier date; from the first date it is "all".
  const earlier = earlierDate(segment, on);
  if (input.scope === "this") {
    const planned = scheduledSpan(segment, on, timeZone);
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
    insertSegment(sc, loaded.owner, tail, at, loaded.texts);
  }
}
