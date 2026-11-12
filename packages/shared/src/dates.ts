/**
 * Calendar date helpers. Calendar dates are `YYYY-MM-DD` strings in the user's time zone; instants
 * are UTC ISO strings or Date objects. Every function that needs a zone takes it as a parameter,
 * so the logic does not depend on the machine's zone.
 */

const DAY_MS = 86_400_000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClock(instant: number, timeZone: string): WallClock {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 0,
    day: parts.day ?? 0,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

function toInstant(value: Date | string | number): number {
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new RangeError(`Not a valid instant: ${String(value)}`);
  return ms;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** The machine's time zone, e.g. "Europe/Zurich". */
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function isCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function dateToUtcMs(date: string): number {
  if (!isCalendarDate(date)) throw new RangeError(`Not a calendar date (YYYY-MM-DD): ${date}`);
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function utcMsToDate(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** The local calendar date of an instant in the given zone. */
export function toLocalDate(instant: Date | string | number, timeZone: string): string {
  const w = wallClock(toInstant(instant), timeZone);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). DST does not matter here. */
export function daysBetween(from: string, to: string): number {
  return Math.round((dateToUtcMs(to) - dateToUtcMs(from)) / DAY_MS);
}

export function addDays(date: string, days: number): string {
  return utcMsToDate(dateToUtcMs(date) + days * DAY_MS);
}

/** Calendar days between the local date of an instant and `today` (0 for today). */
export function daysSince(instant: Date | string | number, today: string, timeZone: string): number {
  return daysBetween(toLocalDate(instant, timeZone), today);
}

/** The UTC instant at which the given local date starts in the zone (handles DST shifts). */
export function startOfLocalDay(date: string, timeZone: string): Date {
  const target = dateToUtcMs(date);
  const offsetAt = (instant: number): number => {
    const w = wallClock(instant, timeZone);
    const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
    return asUtc - (instant - (((instant % 1000) + 1000) % 1000));
  };
  let guess = target - offsetAt(target);
  guess = target - offsetAt(guess);
  // A zone that skips midnight (DST at 00:00) starts the day at the first existing minute.
  if (toLocalDate(guess, timeZone) !== date) guess += 3_600_000;
  return new Date(guess);
}

/** Local wall-clock time of an instant, "YYYY-MM-DD HH:mm" (for thread lines and exports). */
export function toLocalDateTime(instant: Date | string | number, timeZone: string): string {
  const w = wallClock(toInstant(instant), timeZone);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)} ${pad(w.hour)}:${pad(w.minute)}`;
}

/** 1 = Monday ... 7 = Sunday, for a calendar date. */
function isoWeekday(date: string): number {
  const day = new Date(dateToUtcMs(date)).getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * The seven calendar dates (Monday to Sunday) of the week that contains `date`. A calendar date is
 * used as is; an instant is first turned into its local date in the zone. Works on calendar dates
 * only, so DST changes cannot shift a day.
 */
export function weekDays(date: Date | string | number, timeZone: string): string[] {
  const local = typeof date === "string" && DATE_PATTERN.test(date) ? date : toLocalDate(date, timeZone);
  const monday = addDays(local, 1 - isoWeekday(local));
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}
