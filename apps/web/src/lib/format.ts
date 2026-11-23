import {
  DEFAULT_FORMATS,
  daysBetween,
  daysSince,
  type FormatPrefs,
  formatDateAs,
  formatDayMonthAs,
  formatDuration,
  formatMonthAs,
  formatTimeAs,
  systemTimeZone,
  toLocalDate,
  toLocalTime,
} from "@organizer/shared";

/**
 * Every date and time the app shows goes through here, in the account's formats (Account page): "03.10.2026"
 * or "10/03/2026", "03.10." where only short text fits, "15:00" or "3:00 PM". Never month names, the same
 * for every browser locale. Data keeps "YYYY-MM-DD" and "HH:mm".
 */
let prefs: FormatPrefs = DEFAULT_FORMATS;

/** Set at start and when the account's formats change (lib/formatPrefs.tsx re-renders the app after). */
export function setFormatPrefs(next: FormatPrefs): void {
  prefs = next;
}
export const formatPrefs = (): FormatPrefs => prefs;

/** A calendar date, "03.10.2026". */
export const formatDate = (date: string): string => formatDateAs(date, prefs.dateFormat);
/** Day and month, "03.10.". */
export const formatDayMonth = (date: string): string => formatDayMonthAs(date, prefs.dateFormat);
/** A full hour for axes and grids: "13:00", or "1 PM" (narrow columns). */
export function formatHour(hour: number): string {
  if (prefs.timeFormat === "24h") return `${String(hour % 24).padStart(2, "0")}:00`;
  const h = hour % 24;
  return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`;
}

/** A wall clock time "15:00" as the account shows it ("15:00" or "3:00 PM"). */
export const formatTime = (time: string): string => formatTimeAs(time, prefs.timeFormat);

export const timeZone = systemTimeZone();

export function today(now: Date = new Date()): string {
  return toLocalDate(now, timeZone);
}

/** The local calendar day of an instant, "2026-11-12". */
export function toDate(instant: string): string {
  return toLocalDate(instant, timeZone);
}

/** Age of an open todo, one unit only so the column stays narrow: "41d", "3h", "12m". */
export function shortAge(createdAt: string, now: Date = new Date()): string {
  const days = daysSince(createdAt, today(now), timeZone);
  if (days >= 1) return `${days}d`;
  return formatDuration(now.getTime() - Date.parse(createdAt)).split(" ")[0] ?? "0m";
}

export type DueState = "overdue" | "today" | "soon" | "later";

export function dueState(dueOn: string, now: Date = new Date()): DueState {
  const days = daysBetween(today(now), dueOn);
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days <= 3) return "soon";
  return "later";
}

const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" });

/** The short weekday of a calendar date, "Mon". */
export function weekdayName(date: string): string {
  return WEEKDAY.format(new Date(`${date}T12:00:00Z`));
}

/** Weekday and short date for day headers and lists of days, "Mon 03.10.". */
export function dayLabel(date: string): string {
  return `${weekdayName(date)} ${formatDayMonth(date)}`;
}

/** A month of the year, "2026-10" as "10.2026". */
export function formatMonth(month: string): string {
  return formatMonthAs(month, prefs.dateFormat);
}

/**
 * A calendar date for lists: "Today", "Tomorrow", "Yesterday", the weekday within the next six days,
 * else "13.11." (the full "13.11.2027" when it is not this year).
 */
export function shortDate(date: string, now: Date = new Date()): string {
  const days = daysBetween(today(now), date);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  if (days > 1 && days < 7) return weekdayName(date);
  return date.slice(0, 4) === today(now).slice(0, 4) ? formatDayMonth(date) : formatDate(date);
}

/** "overdue 2d", "due today", "due tomorrow", "due in 5d". */
export function dueText(dueOn: string, now: Date = new Date()): string {
  const days = daysBetween(today(now), dueOn);
  if (days < 0) return `overdue ${-days}d`;
  if (days === 0) return "due today";
  if (days === 1) return "due tomorrow";
  return `due in ${days}d`;
}

/** "11.11.2026 14:30" in local time. */
export function absoluteTime(instant: string): string {
  return `${formatDate(toDate(instant))} ${formatTime(toLocalTime(instant, timeZone))}`;
}

/** The local time of an instant as the account shows it, "15:00". */
export function localClock(instant: string): string {
  return formatTime(toLocalTime(instant, timeZone));
}

/** The local calendar day of an instant, "11.11.2026". */
export function absoluteDate(instant: string): string {
  return formatDate(toDate(instant));
}

/** "just now", "12m ago", "3h ago", "4d ago". */
export function relativeTime(instant: string, now: Date = new Date()): string {
  const ms = now.getTime() - Date.parse(instant);
  if (ms < 60_000) return "just now";
  return `${formatDuration(ms).split(" ")[0]} ago`;
}

/** "812 B", "4.2 KB", "13.0 MB", "1.2 GB" (powers of 1024, one decimal from KB on). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** "took 2d 4h" for a done todo with a measured duration. */
export function tookText(todo: { status: string; durationMs: number | null }): string | undefined {
  return todo.status === "done" && todo.durationMs !== null
    ? `took ${formatDuration(todo.durationMs)}`
    : undefined;
}
