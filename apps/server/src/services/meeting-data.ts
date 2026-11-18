import {
  type ExpandedOccurrence,
  formatDate,
  nextSeriesOccurrence,
  isSeriesDate,
  type SeriesException,
  type SeriesSpan,
  StandupFilter,
  toLocalDate,
} from "@organizer/shared";
import { eq, inArray } from "drizzle-orm";
import { labels, meetings, projects } from "../db/schema.ts";
import { ApiError, notFound } from "../http/errors.ts";
import type { Scoped } from "./context.ts";
import { owned } from "./owned.ts";
import { exceptionsOf, segmentsOfOwners } from "./series-editor.ts";
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

/** The segments of each meeting, by first date. */
export function segmentsOf(sc: Scoped, meetingIds: readonly number[]): Map<number, SeriesSpan[]> {
  return segmentsOfOwners(sc, "meeting", meetingIds);
}

export { exceptionsOf, readSpan } from "./series-editor.ts";

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
