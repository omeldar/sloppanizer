import { daysBetween, daysSince, formatDuration, systemTimeZone, toLocalDate } from "@organizer/shared";

export const timeZone = systemTimeZone();

export function today(now: Date = new Date()): string {
  return toLocalDate(now, timeZone);
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

/** "overdue 2d", "due today", "due tomorrow", "due in 5d". */
export function dueText(dueOn: string, now: Date = new Date()): string {
  const days = daysBetween(today(now), dueOn);
  if (days < 0) return `overdue ${-days}d`;
  if (days === 0) return "due today";
  if (days === 1) return "due tomorrow";
  return `due in ${days}d`;
}

const absolute = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone,
});

/** "2026-11-11 14:30" in local time. */
export function absoluteTime(instant: string): string {
  const parts = Object.fromEntries(absolute.formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`;
}

/** "just now", "12m ago", "3h ago", "4d ago". */
export function relativeTime(instant: string, now: Date = new Date()): string {
  const ms = now.getTime() - Date.parse(instant);
  if (ms < 60_000) return "just now";
  return `${formatDuration(ms).split(" ")[0]} ago`;
}
