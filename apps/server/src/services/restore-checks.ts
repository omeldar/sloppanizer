import {
  CalendarDate,
  MAX_EXCEPTIONS,
  MAX_MEETING_TODOS,
  MAX_MEETINGS,
  MAX_SEGMENTS,
  StandupFilter,
  Timestamp,
} from "@organizer/shared";
import { readSpan } from "./meeting-data.ts";

/**
 * Checks of meeting rows in a restore that the database cannot do: the JSON columns hold what the
 * services read, dates and instants have their format, and the limits per account hold. A hand-made file
 * then fails with the table and row instead of breaking the account's meetings list later.
 */

type Row = Record<string, unknown>;

const isDate = (value: unknown): boolean => CalendarDate.safeParse(value).success;
const isInstant = (value: unknown): boolean => Timestamp.safeParse(value).success;

function jsonOf(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Why a row cannot be restored, or null. Tables without checks are fine. */
const ROW_CHECKS: Partial<Record<string, (row: Row) => string | null>> = {
  meetings: (row) => {
    if (row.filter !== undefined && !StandupFilter.safeParse(jsonOf(row.filter)).success)
      return "filter is not a standup filter (projectIds, inbox, labelIds)";
    return isInstant(row.since) ? null : "since is not a UTC time";
  },
  series: (row) => {
    if (row.owner_kind !== "meeting") return 'owner_kind must be "meeting"';
    if (typeof row.meeting_id !== "number") return "meeting_id is missing";
    const span = readSpan({
      id: Number(row.id),
      rule: String(row.rule),
      startsOn: String(row.starts_on),
      endsOn: row.ends_on === null || row.ends_on === undefined ? null : String(row.ends_on),
      startTime: String(row.start_time),
      durationMin: Number(row.duration_min),
    });
    return span ? null : "not a usable repeat (rule, dates, start time or length)";
  },
  series_exceptions: (row) => {
    if (!isDate(row.occurs_on)) return "occurs_on is not a date";
    if (row.kind === "moved" && !(isInstant(row.start_at) && isInstant(row.end_at)))
      return "a moved date needs start_at and end_at as UTC times";
    if (row.kind === "cancelled" && (row.start_at != null || row.end_at != null))
      return "a cancelled date has no start_at or end_at";
    return null;
  },
  meeting_notes: (row) => (isDate(row.occurs_on) ? null : "occurs_on is not a date"),
  meeting_todos: (row) => (isInstant(row.added_at) ? null : "added_at is not a UTC time"),
  standup_marks: (row) => {
    if (!isDate(row.occurs_on)) return "occurs_on is not a date";
    return isInstant(row.covered_until) && isInstant(row.marked_at)
      ? null
      : "covered_until and marked_at must be UTC times";
  },
};

export function rowProblem(table: string, row: Row): string | null {
  return ROW_CHECKS[table]?.(row) ?? null;
}

const countBy = (rows: readonly Row[], key: string): Map<unknown, number> => {
  const out = new Map<unknown, number>();
  for (const row of rows) out.set(row[key], (out.get(row[key]) ?? 0) + 1);
  return out;
};

/** The limits per account, meeting and repeat part: the first one over, with its table, or null. */
export function limitProblem(
  data: Record<string, readonly Row[]>,
): { table: string; message: string } | null {
  if ((data.meetings ?? []).length > MAX_MEETINGS)
    return { table: "meetings", message: `more than ${MAX_MEETINGS} meetings in one account` };
  for (const [meetingId, n] of countBy(data.series ?? [], "meeting_id")) {
    if (n > MAX_SEGMENTS)
      return { table: "series", message: `meeting ${String(meetingId)} has more than ${MAX_SEGMENTS} parts` };
  }
  for (const [meetingId, n] of countBy(data.meeting_todos ?? [], "meeting_id")) {
    if (n > MAX_MEETING_TODOS)
      return {
        table: "meeting_todos",
        message: `meeting ${String(meetingId)} has more than ${MAX_MEETING_TODOS} todos`,
      };
  }
  for (const [seriesId, n] of countBy(data.series_exceptions ?? [], "series_id")) {
    if (n > MAX_EXCEPTIONS)
      return {
        table: "series_exceptions",
        message: `series ${String(seriesId)} has more than ${MAX_EXCEPTIONS} changed dates`,
      };
  }
  return null;
}
