import {
  type ExpandedOccurrence,
  formatDate,
  isCalendarDate,
  nextSeriesOccurrence,
  isSeriesDate,
  type SeriesException,
  SeriesRule,
  type SeriesSpan,
  seriesProblem,
  StandupFilter,
  TimeOfDay,
  Timestamp,
  toLocalDate,
} from "@organizer/shared";
import { asc, eq, inArray } from "drizzle-orm";
import { labels, meetings, projects, series, seriesExceptions } from "../db/schema.ts";
import { ApiError, notFound } from "../http/errors.ts";
import type { Scoped } from "./context.ts";
import { owned } from "./owned.ts";
import { chunks } from "./sql.ts";

/** Reading meetings, their series segments and single date changes (shared by meetings and standups). */

export type MeetingRow = typeof meetings.$inferSelect;

export function meetingRow(sc: Scoped, id: number): MeetingRow {
  const row = sc.db
    .select()
    .from(meetings)
    .where(owned(sc, meetings, eq(meetings.id, id)))
    .get();
  if (!row) throw notFound("Meeting", id);
  return row;
}

/** The stored filter; anything unreadable counts as everything. */
export function parseFilter(json: string): StandupFilter {
  try {
    const result = StandupFilter.safeParse(JSON.parse(json));
    if (result.success) return result.data;
  } catch {
    // fall through
  }
  return StandupFilter.parse({});
}

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

const isInstant = (value: string | null): value is string =>
  value !== null && Timestamp.safeParse(value).success;

/** The segments of each meeting, by first date. */
export function segmentsOf(sc: Scoped, meetingIds: readonly number[]): Map<number, SeriesSpan[]> {
  const out = new Map<number, SeriesSpan[]>(meetingIds.map((id) => [id, []]));
  for (const part of chunks(meetingIds)) {
    const rows = sc.db
      .select()
      .from(series)
      .where(owned(sc, series, eq(series.ownerKind, "meeting"), inArray(series.meetingId, part)))
      .orderBy(asc(series.startsOn), asc(series.id))
      .all();
    for (const row of rows) {
      const span = readSpan(row);
      if (span) out.get(row.meetingId as number)?.push(span);
    }
  }
  return out;
}

/** Every single date change of the segments (a few per meeting and year). */
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

/** The meeting's next date that has not ended at `at`: cancelled ones skipped, moved ones at their new time. */
export function nextOf(
  segments: readonly SeriesSpan[],
  exceptions: readonly SeriesException[],
  at: Date,
  timeZone: string,
): ExpandedOccurrence | null {
  const own = new Set(segments.map((s) => s.id));
  return nextSeriesOccurrence(
    segments,
    exceptions.filter((e) => own.has(e.seriesId)),
    at,
    timeZone,
  );
}

/** The day (in the account's zone) of each meeting's next date, or null when it has none. */
export function nextDays(
  sc: Scoped,
  meetingIds: readonly number[],
  at: Date,
  timeZone: string,
): Map<number, string | null> {
  const segments = segmentsOf(sc, meetingIds);
  const exceptions = exceptionsOf(
    sc,
    [...segments.values()].flatMap((list) => list.map((s) => s.id)),
  );
  return new Map(
    meetingIds.map((id) => {
      const next = nextOf(segments.get(id) ?? [], exceptions, at, timeZone);
      return [id, next === null ? null : toLocalDate(next.startAt, timeZone)];
    }),
  );
}

/** The segment that holds an original date of the meeting; 404 when the meeting has no such date. */
export function segmentOn(meetingId: number, segments: readonly SeriesSpan[], on: string): SeriesSpan {
  const segment = segments.find((s) => isSeriesDate(s, on));
  if (!segment) throw new ApiError("not_found", `Meeting ${meetingId} has no date on ${formatDate(on)}.`);
  return segment;
}

/** The filter with every project and label checked against the account (404 for a foreign or unknown id). */
export function checkedFilter(sc: Scoped, filter: StandupFilter): StandupFilter {
  const check = (table: typeof projects | typeof labels, what: string, ids: readonly number[]) => {
    const found = new Set<number>();
    for (const part of chunks(ids)) {
      for (const row of sc.db
        .select({ id: table.id })
        .from(table)
        .where(owned(sc, table, inArray(table.id, part)))
        .all()) {
        found.add(row.id);
      }
    }
    const missing = ids.find((id) => !found.has(id));
    if (missing !== undefined) throw notFound(what, missing);
  };
  check(projects, "Project", filter.projectIds);
  check(labels, "Label", filter.labelIds);
  return filter;
}
