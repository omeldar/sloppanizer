import {
  addDays,
  daysBetween,
  formatDate,
  localTimeToInstant,
  startOfLocalDay,
  toLocalDate,
} from "./dates.ts";
import {
  describeRecurrence,
  matchesRule,
  nextRuleDate,
  previousRuleDate,
  type RecurrenceRule,
  WEEKDAYS,
} from "./recurrence.ts";

/**
 * Series: something that repeats on a schedule at a wall-clock time (meetings now, recurring planner
 * blocks later). A series segment has a schedule rule anchored at its first date, an optional last
 * date, a start time and a length. Single dates can be moved or cancelled through exceptions, keyed by
 * the original date. All date math works on calendar dates; instants come from the wall-clock time in
 * the account's zone, so a meeting stays at 09:00 across DST changes.
 */

export interface SeriesSpan {
  id: number;
  /** A normalized schedule rule (basis schedule, no until), anchored at startsOn. */
  rule: RecurrenceRule;
  startsOn: string;
  /** The last possible date, or null when the series is open. */
  endsOn: string | null;
  /** "HH:MM" wall-clock time in the account's zone. */
  startTime: string;
  durationMinutes: number;
}

export const OCCURRENCE_STATUSES = ["scheduled", "moved", "cancelled"] as const;
type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

export interface SeriesException {
  seriesId: number;
  /** The original date of the occurrence. */
  occursOn: string;
  kind: "cancelled" | "moved";
  /** UTC instants, set when moved. */
  startAt: string | null;
  endAt: string | null;
}

export interface ExpandedOccurrence {
  seriesId: number;
  /** The original date (the key of notes, marks and exceptions). */
  occursOn: string;
  startAt: string;
  endAt: string;
  status: OccurrenceStatus;
}

/** Days a repeat may span from its first to its last date (ten years and a bit). */
export const MAX_SERIES_DAYS = 3660;
/** Repeats stay inside these years, so date math never leaves four-digit years. */
export const SERIES_FIRST_DAY = "1900-01-01";
export const SERIES_LAST_DAY = "2999-12-31";

/**
 * Why a segment's dates do not work, or null: it ends before it starts, spans more than
 * MAX_SERIES_DAYS, leaves the years 1900 to 2999 or has no date at all. Constant time: it looks for the
 * first date only.
 */
export function seriesProblem(series: Omit<SeriesSpan, "id">): string | null {
  const { startsOn, endsOn } = series;
  if (
    startsOn < SERIES_FIRST_DAY ||
    startsOn > SERIES_LAST_DAY ||
    (endsOn !== null && endsOn > SERIES_LAST_DAY)
  )
    return "Pick dates between 1900 and 2999.";
  if (endsOn === null) return null;
  if (endsOn < startsOn) return "The repeat must not end before its first date.";
  if (daysBetween(startsOn, endsOn) > MAX_SERIES_DAYS)
    return "A repeat can run for at most 10 years. Pick an earlier last date or leave it open.";
  if (firstSeriesDate(series) === null)
    return `The repeat has no date from ${formatDate(startsOn)} to ${formatDate(endsOn)}. Change the days or the dates.`;
  return null;
}

/** The first original date on or after `from` (default: the first date), or null when there is none. */
export function firstSeriesDate(
  series: Omit<SeriesSpan, "id">,
  from: string = series.startsOn,
): string | null {
  const start = from > series.startsOn ? from : series.startsOn;
  if (series.endsOn !== null && start > series.endsOn) return null;
  const { rule, startsOn } = series;
  const date = matchesRule(rule, startsOn, start) ? start : nextRuleDate(rule, startsOn, start);
  return series.endsOn === null || date <= series.endsOn ? date : null;
}

/** Whether the date is one of the series' original dates. */
export function isSeriesDate(series: Omit<SeriesSpan, "id">, date: string): boolean {
  return (
    date >= series.startsOn &&
    (series.endsOn === null || date <= series.endsOn) &&
    matchesRule(series.rule, series.startsOn, date)
  );
}

/** The original dates of a series in from..to (both included). */
export function seriesDates(series: Omit<SeriesSpan, "id">, from: string, to: string): string[] {
  const start = from > series.startsOn ? from : series.startsOn;
  const end = series.endsOn !== null && series.endsOn < to ? series.endsOn : to;
  const out: string[] = [];
  if (start > end) return out;
  const { rule, startsOn } = series;
  let date = matchesRule(rule, startsOn, start) ? start : nextRuleDate(rule, startsOn, start);
  while (date <= end) {
    out.push(date);
    date = nextRuleDate(rule, startsOn, date);
  }
  return out;
}

/** Start and end of the scheduled (not moved) occurrence on a date. */
export function scheduledSpan(
  series: Pick<SeriesSpan, "startTime" | "durationMinutes">,
  date: string,
  timeZone: string,
): { startAt: string; endAt: string } {
  const start = localTimeToInstant(date, series.startTime, timeZone);
  return {
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + series.durationMinutes * 60_000).toISOString(),
  };
}

const keyOf = (seriesId: number, date: string): string => `${seriesId}|${date}`;

function occurrence(
  series: SeriesSpan,
  date: string,
  exception: SeriesException | undefined,
  timeZone: string,
): ExpandedOccurrence {
  if (exception?.kind === "moved" && exception.startAt !== null && exception.endAt !== null) {
    return {
      seriesId: series.id,
      occursOn: date,
      startAt: exception.startAt,
      endAt: exception.endAt,
      status: "moved",
    };
  }
  return {
    seriesId: series.id,
    occursOn: date,
    ...scheduledSpan(series, date, timeZone),
    status: exception?.kind === "cancelled" ? "cancelled" : "scheduled",
  };
}

const byStart = (a: ExpandedOccurrence, b: ExpandedOccurrence): number =>
  a.startAt.localeCompare(b.startAt) || a.seriesId - b.seriesId || a.occursOn.localeCompare(b.occursOn);

/**
 * The occurrences that overlap the days from..to in the zone, by start. Moved ones count at their new
 * time: one moved into the range is included even when its original date is outside, one moved out is
 * not. Cancelled ones are included with status "cancelled" at their scheduled time. Pass the exceptions
 * of the original dates in range and of the moved ones whose new time is in range.
 */
export function expandSeries(
  series: readonly SeriesSpan[],
  exceptions: readonly SeriesException[],
  from: string,
  to: string,
  timeZone: string,
): ExpandedOccurrence[] {
  const lo = startOfLocalDay(from, timeZone).toISOString();
  const hi = startOfLocalDay(addDays(to, 1), timeZone).toISOString();
  const overlaps = (o: ExpandedOccurrence) => o.startAt < hi && o.endAt > lo;
  const byKey = new Map(exceptions.map((e) => [keyOf(e.seriesId, e.occursOn), e]));
  const out: ExpandedOccurrence[] = [];
  for (const s of series) {
    // One day before: an occurrence late in the evening can run into the first day.
    const dates = new Set(seriesDates(s, addDays(from, -1), to));
    for (const date of dates) {
      const o = occurrence(s, date, byKey.get(keyOf(s.id, date)), timeZone);
      if (overlaps(o)) out.push(o);
    }
    for (const e of exceptions) {
      if (e.seriesId !== s.id || e.kind !== "moved" || dates.has(e.occursOn) || !isSeriesDate(s, e.occursOn))
        continue;
      const o = occurrence(s, e.occursOn, e, timeZone);
      if (overlaps(o)) out.push(o);
    }
  }
  return out.toSorted(byStart);
}

/** The occurrence of an original date, or null when no segment has that date. */
export function occurrenceOn(
  series: readonly SeriesSpan[],
  exceptions: readonly SeriesException[],
  date: string,
  timeZone: string,
): ExpandedOccurrence | null {
  const s = series.find((x) => isSeriesDate(x, date));
  if (!s) return null;
  return occurrence(
    s,
    date,
    exceptions.find((e) => e.seriesId === s.id && e.occursOn === date),
    timeZone,
  );
}

/** Steps a walk over a series may take before it gives up (dates that are all cancelled). */
const MAX_STEPS = 1000;

/**
 * The first occurrence that has not ended at `after` (a running one counts), cancelled ones skipped,
 * or null when the series has none.
 */
export function nextSeriesOccurrence(
  series: readonly SeriesSpan[],
  exceptions: readonly SeriesException[],
  after: Date,
  timeZone: string,
): ExpandedOccurrence | null {
  const at = after.toISOString();
  const byKey = new Map(exceptions.map((e) => [keyOf(e.seriesId, e.occursOn), e]));
  const found: ExpandedOccurrence[] = [];
  const startDate = addDays(toLocalDate(after, timeZone), -1);
  for (const s of series) {
    // Moved ones count at their new time, so they are looked at apart from the walk.
    for (const e of exceptions) {
      if (e.seriesId !== s.id || e.kind !== "moved" || !isSeriesDate(s, e.occursOn)) continue;
      const o = occurrence(s, e.occursOn, e, timeZone);
      if (o.endAt > at) found.push(o);
    }
    const first = startDate > s.startsOn ? startDate : s.startsOn;
    let date = matchesRule(s.rule, s.startsOn, first) ? first : nextRuleDate(s.rule, s.startsOn, first);
    for (let i = 0; i < MAX_STEPS && (s.endsOn === null || date <= s.endsOn); i += 1) {
      const exception = byKey.get(keyOf(s.id, date));
      if (exception === undefined) {
        const o = occurrence(s, date, undefined, timeZone);
        if (o.endAt > at) {
          found.push(o);
          break;
        }
      }
      date = nextRuleDate(s.rule, s.startsOn, date);
    }
  }
  return found.toSorted(byStart)[0] ?? null;
}

/**
 * Where the first window of a new meeting starts: the start of the last date of the rule's pattern
 * that began before now (last Thursday 09:00 for a Thursday meeting). Works for a series that starts in
 * the future too, because the pattern is followed back from today, not from the first date.
 */
export function lastStartBefore(series: Omit<SeriesSpan, "id">, now: Date, timeZone: string): string {
  const { rule, startsOn } = series;
  const tomorrow = addDays(toLocalDate(now, timeZone), 1);
  let date = previousRuleDate(rule, startsOn, tomorrow);
  for (let i = 0; i < MAX_STEPS; i += 1) {
    const start = localTimeToInstant(date, series.startTime, timeZone);
    if (start.getTime() < now.getTime()) return start.toISOString();
    date = previousRuleDate(rule, startsOn, date);
  }
  return startOfLocalDay(toLocalDate(now, timeZone), timeZone).toISOString();
}

/**
 * Splits a series at an original date: the part before it (ending the day before, or null when the
 * date is the first one) and the start of the part from it on.
 */
export function splitSeries<T extends Omit<SeriesSpan, "id">>(
  series: T,
  from: string,
): { head: T | null; tail: T } {
  const head = from > series.startsOn ? { ...series, endsOn: addDays(from, -1) } : null;
  return { head, tail: { ...series, startsOn: from } };
}

/** A day of the month that every month has. */
const inEveryMonth = (day: number): boolean => day >= 1 && day <= 28;

/**
 * The rule whose dates are every date of `rule` moved by deltaDays, or null when no rule says that
 * (then only a single date can move to another day). Weekly: the weekdays turn (with a gap of more
 * than one week only while no weekday crosses into another week); daily: unchanged; monthly on a day:
 * that day plus delta while both stay within 1..28.
 */
export function shiftRule(rule: RecurrenceRule, deltaDays: number): RecurrenceRule | null {
  if (deltaDays === 0 || rule.every === "day") return rule;
  if (rule.every === "week" && rule.weekdays) {
    const indexes = rule.weekdays.map((w) => WEEKDAYS.indexOf(w) + deltaDays);
    if (rule.interval > 1 && new Set(indexes.map((i) => Math.floor(i / 7))).size > 1) return null;
    const weekdays = indexes
      .map((i) => (((i % 7) + 7) % 7) as number)
      .toSorted((a, b) => a - b)
      .map((i) => WEEKDAYS[i] as (typeof WEEKDAYS)[number]);
    return { ...rule, weekdays };
  }
  if (rule.every === "month" && rule.monthDay !== undefined && rule.monthWeekday === undefined) {
    const day = rule.monthDay + deltaDays;
    return inEveryMonth(rule.monthDay) && inEveryMonth(day) ? { ...rule, monthDay: day } : null;
  }
  return null;
}

/** The days between an original date and the local date of a new start. */
export const dayShift = (occursOn: string, startAt: string, timeZone: string): number =>
  daysBetween(occursOn, toLocalDate(startAt, timeZone));

const minutesOf = (time: string): number => {
  const [h = "0", m = "0"] = time.split(":");
  return Number(h) * 60 + Number(m);
};

/** "HH:MM" plus minutes on the wall clock, wrapping at midnight. */
export function addMinutesToTime(time: string, minutes: number): string {
  const total = (((minutesOf(time) + minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** "every week on Thu, 09:00–09:15", with " until 31.12.2026" when the series ends. */
export function describeSeries(series: Omit<SeriesSpan, "id">): string {
  const end = addMinutesToTime(series.startTime, series.durationMinutes);
  if (isOneTimeSpan(series)) return `once on ${formatDate(series.startsOn)}, ${series.startTime}–${end}`;
  return `${describeRecurrence({ ...series.rule, until: series.endsOn })}, ${series.startTime}–${end}`;
}

/** A segment with a single date: its first date is also its last (a one-time meeting). */
export const isOneTimeSpan = (series: Pick<SeriesSpan, "startsOn" | "endsOn">): boolean =>
  series.endsOn === series.startsOn;

/** The rule a one-time meeting's single segment is stored with (any rule matches its one date). */
export const ONE_TIME_RULE: RecurrenceRule = { every: "day", interval: 1, basis: "schedule" };
