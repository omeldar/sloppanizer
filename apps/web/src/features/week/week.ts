import { addDays, isCalendarDate, weekDays } from "@organizer/shared";
import { timeZone } from "../../lib/format.ts";

/** The seven days (Monday first) of the week that holds `date`. */
export function daysOfWeek(date: string): string[] {
  return weekDays(date, timeZone);
}

/** The Monday of the week in the URL, or of this week when the URL has none or nonsense. */
export function weekStart(param: string | undefined, today: string): string {
  const date = param && isCalendarDate(param) ? param : today;
  return daysOfWeek(date)[0] as string;
}

export function shiftWeek(start: string, weeks: number): string {
  return addDays(start, 7 * weeks);
}

/** Where a todo shows on the week page; null = not on this page. */
export type WeekPlace = { kind: "day"; date: string } | { kind: "carried" } | { kind: "unplanned" };

export function weekPlace(
  todo: { status: string; plannedOn: string | null },
  days: readonly string[],
): WeekPlace | null {
  const active = todo.status !== "done";
  if (todo.plannedOn === null) return active ? { kind: "unplanned" } : null;
  if (days.includes(todo.plannedOn)) return { kind: "day", date: todo.plannedOn };
  if (active && todo.plannedOn < (days[0] as string)) return { kind: "carried" };
  return null;
}
