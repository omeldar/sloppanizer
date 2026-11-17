import {
  describeRecurrence,
  formatDayMonth,
  isCalendarDate,
  nextOccurrence,
  normalizeRecurrence,
  ordinal,
  RecurrenceRule,
  type RecurrenceRuleInput,
  recurrenceProblem,
  type Weekday,
  weekdayOf,
} from "@organizer/shared";

export const WORKWEEK: Weekday[] = ["mon", "tue", "wed", "thu", "fri"];

export const WEEKDAY_SHORT: Record<Weekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

export interface Preset {
  label: string;
  rule: RecurrenceRule;
}

/** The one-click choices, worded from the todo's date (due date, else planned day). */
export function presets(anchor: string): Preset[] {
  const weekday = weekdayOf(anchor);
  const day = Number(anchor.slice(8, 10));
  const yearDate = anchor.slice(5);
  const rule = (input: RecurrenceRuleInput) => normalizeRecurrence(input, anchor);
  return [
    { label: "Every day", rule: rule({ every: "day" }) },
    { label: "Every weekday", rule: rule({ every: "week", weekdays: WORKWEEK }) },
    { label: `Every week on ${WEEKDAY_SHORT[weekday]}`, rule: rule({ every: "week", weekdays: [weekday] }) },
    { label: `Every month on the ${ordinal(day)}`, rule: rule({ every: "month", monthDay: day }) },
    { label: `Every year on ${formatDayMonth(yearDate)}`, rule: rule({ every: "year", yearDate }) },
  ];
}

/** Same rule after both are filled from the anchor (weekday order, defaults). */
export function sameRule(a: RecurrenceRuleInput, b: RecurrenceRuleInput, anchor: string): boolean {
  return JSON.stringify(canonical(a, anchor)) === JSON.stringify(canonical(b, anchor));
}

function canonical(rule: RecurrenceRuleInput, anchor: string) {
  const full = normalizeRecurrence(rule, anchor);
  return Object.fromEntries(
    Object.entries(full)
      .filter(([, value]) => value !== undefined && value !== null)
      .toSorted(([x], [y]) => x.localeCompare(y)),
  );
}

export type Check =
  | { ok: true; rule: RecurrenceRule; text: string; next: string | null }
  | { ok: false; problem: string };

/** Validates a rule the way the server does and says when the next one would be. */
export function checkRule(input: RecurrenceRuleInput, anchor: string, today: string): Check {
  const parsed = RecurrenceRule.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // The form takes the date in the year as "14.03.", the API as "03-14": say it the form's way.
    if (issue?.path[0] === "yearDate") return { ok: false, problem: YEAR_DATE_PROBLEM };
    return { ok: false, problem: issue?.message ?? "This repeat does not work." };
  }
  const problem = recurrenceProblem(parsed.data, anchor);
  if (problem) return { ok: false, problem };
  const rule = normalizeRecurrence(parsed.data, anchor);
  return {
    ok: true,
    rule,
    text: describeRecurrence(rule),
    next: nextOccurrence(rule, { anchor, doneOn: today, today }),
  };
}

export const YEAR_DATE_PROBLEM = "Use a day and month like 14.03.";

/** What the user typed for a date in the year, "14.03." or "14.3", as the rule's "03-14"; null if no such day. */
export function parseYearDate(text: string): string | null {
  const match = /^\s*(\d{1,2})\.(\d{1,2})\.?\s*$/.exec(text);
  if (!match) return null;
  const [, day = "", month = ""] = match;
  const value = `${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  // 2000 is a leap year, so 29.02. counts.
  return isCalendarDate(`2000-${value}`) ? value : null;
}

/** Custom form state, kept flat so switching units keeps what the user typed. */
export interface Draft {
  every: RecurrenceRule["every"];
  interval: number;
  weekdays: Weekday[];
  monthMode: "day" | "weekday";
  monthDay: number;
  nth: 1 | 2 | 3 | 4 | -1;
  nthWeekday: Weekday;
  /** As the user reads and types it, "14.03.". */
  yearDate: string;
  basis: "schedule" | "done";
  until: string;
}

export function draftFrom(rule: RecurrenceRule | null, anchor: string): Draft {
  const full = normalizeRecurrence(rule ?? { every: "week" }, anchor);
  const day = Number(anchor.slice(8, 10));
  return {
    every: full.every,
    interval: full.interval,
    weekdays: full.weekdays ?? [weekdayOf(anchor)],
    monthMode: full.monthWeekday ? "weekday" : "day",
    monthDay: full.monthDay ?? day,
    nth: full.monthWeekday?.nth ?? (Math.min(4, Math.ceil(day / 7)) as 1 | 2 | 3 | 4),
    nthWeekday: full.monthWeekday?.weekday ?? weekdayOf(anchor),
    yearDate: formatDayMonth(full.yearDate ?? anchor.slice(5)),
    basis: full.basis,
    until: full.until ?? "",
  };
}

/** The rule a draft stands for; calendar patterns only for the schedule basis. */
export function ruleFrom(draft: Draft): RecurrenceRuleInput {
  const base = {
    every: draft.every,
    interval: draft.interval,
    basis: draft.basis,
    ...(draft.until && { until: draft.until }),
  };
  if (draft.basis === "done") return base;
  if (draft.every === "week") return { ...base, weekdays: draft.weekdays };
  if (draft.every === "month") {
    return draft.monthMode === "day"
      ? { ...base, monthDay: draft.monthDay }
      : { ...base, monthWeekday: { nth: draft.nth, weekday: draft.nthWeekday } };
  }
  if (draft.every === "year") return { ...base, yearDate: parseYearDate(draft.yearDate) ?? draft.yearDate };
  return base;
}
