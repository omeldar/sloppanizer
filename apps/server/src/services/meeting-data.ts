import {
  formatDate,
  isSeriesDate,
  RecurrenceRule,
  type SeriesException,
  type SeriesSpan,
  StandupFilter,
} from "@organizer/shared";
import { asc, eq, inArray } from "drizzle-orm";
import { labels, meetings, projects, series, seriesExceptions } from "../db/schema.ts";
import { ApiError, notFound } from "../http/errors.ts";
import type { Scoped } from "./context.ts";
import { owned } from "./owned.ts";
import { chunks } from "./sql.ts";

/** Reading meetings, their series segments and single date changes (shared by meetings and standups). */

export type MeetingRow = typeof meetings.$inferSelect;
type SeriesRow = typeof series.$inferSelect;

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

export function toSpan(row: SeriesRow): SeriesSpan {
  return {
    id: row.id,
    rule: RecurrenceRule.parse(JSON.parse(row.rule)),
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    startTime: row.startTime,
    durationMinutes: row.durationMin,
  };
}

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
    for (const row of rows) out.get(row.meetingId as number)?.push(toSpan(row));
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
