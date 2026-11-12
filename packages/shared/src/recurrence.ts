import { z } from "zod";
import { addDays, daysBetween, isCalendarDate } from "./dates.ts";
import { CalendarDate } from "./primitives.ts";

/**
 * Repeating todos. A rule says how the next date follows from the current one; all math works on
 * calendar dates (`YYYY-MM-DD`), so time zones and DST cannot shift a day. The caller passes
 * `today` and `doneOn` in the user's zone.
 */

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export const Weekday = z.enum(WEEKDAYS);
export type Weekday = z.infer<typeof Weekday>;

export const RECURRENCE_UNITS = ["day", "week", "month", "year"] as const;
export const RecurrenceUnit = z.enum(RECURRENCE_UNITS);
export type RecurrenceUnit = z.infer<typeof RecurrenceUnit>;

export const RECURRENCE_BASES = ["schedule", "done"] as const;

/** Message for basis "done" with a calendar pattern. */
export const DONE_BASIS_MESSAGE =
  "Repeats counted from the done date use a plain interval, like every 3 days.";

const YEAR_DATE = /^(\d{2})-(\d{2})$/;

/** "MM-DD"; 02-29 is allowed (it falls on Feb 28 in other years). */
const YearDate = z
  .string()
  .refine(
    (value) => isCalendarDate(`2000-${value}`) && YEAR_DATE.test(value),
    "Use a date like 03-14 (MM-DD).",
  );

export const RecurrenceRule = z
  .strictObject({
    every: RecurrenceUnit,
    interval: z
      .number()
      .int()
      .min(1, "Repeat at least every 1.")
      .max(99, "Repeat at most every 99.")
      .default(1),
    /** Only with every=week. */
    weekdays: z
      .array(Weekday)
      .min(1, "Pick at least one weekday.")
      .max(7)
      .refine((days) => new Set(days).size === days.length, "Each weekday may appear only once.")
      .optional(),
    /** Only with every=month; -1 = the last day of the month. */
    monthDay: z.union([z.number().int().min(1).max(31), z.literal(-1)]).optional(),
    /** Only with every=month, not together with monthDay; nth -1 = the last one. */
    monthWeekday: z
      .strictObject({
        nth: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(-1)]),
        weekday: Weekday,
      })
      .optional(),
    /** Only with every=year. */
    yearDate: YearDate.optional(),
    /** schedule: the next date follows the plan; done: counted from the day it was done. */
    basis: z.enum(RECURRENCE_BASES).default("schedule"),
    /** No occurrence after this date. */
    until: CalendarDate.nullable().optional(),
  })
  .superRefine((rule, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (rule.weekdays !== undefined && rule.every !== "week")
      issue("weekdays", "Weekdays only work with a weekly repeat.");
    if (rule.monthDay !== undefined && rule.every !== "month")
      issue("monthDay", "A day of the month only works with a monthly repeat.");
    if (rule.monthWeekday !== undefined && rule.every !== "month")
      issue("monthWeekday", "A weekday of the month only works with a monthly repeat.");
    if (rule.monthDay !== undefined && rule.monthWeekday !== undefined)
      issue("monthWeekday", "Pick either a day of the month or a weekday of the month, not both.");
    if (rule.yearDate !== undefined && rule.every !== "year")
      issue("yearDate", "A date in the year only works with a yearly repeat.");
    if (
      rule.basis === "done" &&
      (rule.weekdays !== undefined ||
        rule.monthDay !== undefined ||
        rule.monthWeekday !== undefined ||
        rule.yearDate !== undefined)
    ) {
      issue("basis", DONE_BASIS_MESSAGE);
    }
  });
export type RecurrenceRule = z.infer<typeof RecurrenceRule>;
export type RecurrenceRuleInput = z.input<typeof RecurrenceRule>;

// ---------- calendar helpers ----------

interface Ymd {
  y: number;
  m: number;
  d: number;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
const parse = (date: string): Ymd => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return { y, m, d };
};
const format = ({ y, m, d }: Ymd): string => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 0 = Monday ... 6 = Sunday. */
function weekdayIndex(date: string): number {
  const { y, m, d } = parse(date);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

export function weekdayOf(date: string): Weekday {
  return WEEKDAYS[weekdayIndex(date)] as Weekday;
}

/** Month number counted from year 0, so month differences are plain subtraction. */
const monthIndex = ({ y, m }: Ymd): number => y * 12 + (m - 1);
const fromMonthIndex = (index: number): { y: number; m: number } => ({
  y: Math.floor(index / 12),
  m: (index % 12) + 1,
});

/** Day `day` (or the last day for -1) of a month, clamped to the month's length. */
function monthDate(y: number, m: number, day: number): string {
  const last = daysInMonth(y, m);
  return format({ y, m, d: day === -1 ? last : Math.min(day, last) });
}

/** The nth (1..4, or -1 = last) given weekday of a month. */
function nthWeekdayDate(y: number, m: number, nth: number, weekday: Weekday): string {
  const target = WEEKDAYS.indexOf(weekday);
  if (nth === -1) {
    const last = format({ y, m, d: daysInMonth(y, m) });
    return addDays(last, -((weekdayIndex(last) - target + 7) % 7));
  }
  const first = format({ y, m, d: 1 });
  return addDays(first, ((target - weekdayIndex(first) + 7) % 7) + (nth - 1) * 7);
}

/** Feb 29 falls on Feb 28 in years without it. */
function yearDateIn(y: number, yearDate: string): string {
  const [m, d] = yearDate.split("-").map(Number) as [number, number];
  return format({ y, m, d: Math.min(d, daysInMonth(y, m)) });
}

function addMonthsClamped(date: string, months: number): string {
  const { y, m, d } = parse(date);
  const target = fromMonthIndex(monthIndex({ y, m, d }) + months);
  return monthDate(target.y, target.m, d);
}

// ---------- rules ----------

/**
 * Fills the calendar pattern from the anchor (the todo's due date, else its planned day), so the
 * dates do not drift: monthly on Jan 31 stays on the 31st (clamped in shorter months), yearly on
 * Feb 29 falls on Feb 28 in other years, weekly gets the anchor's weekday. Rules counted from the
 * done date stay a plain interval.
 */
export function normalizeRecurrence(rule: RecurrenceRuleInput, anchor: string): RecurrenceRule {
  const out: RecurrenceRule = {
    ...rule,
    interval: rule.interval ?? 1,
    basis: rule.basis ?? "schedule",
  };
  if (out.basis === "done") return out;
  const { m, d } = parse(anchor);
  if (out.every === "week" && out.weekdays === undefined) out.weekdays = [weekdayOf(anchor)];
  if (out.every === "week" && out.weekdays !== undefined)
    out.weekdays = out.weekdays.toSorted((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
  if (out.every === "month" && out.monthDay === undefined && out.monthWeekday === undefined) out.monthDay = d;
  if (out.every === "year" && out.yearDate === undefined) out.yearDate = `${pad(m)}-${pad(d)}`;
  return out;
}

/** Why a rule does not fit the anchor date, or null when it is fine. */
export function recurrenceProblem(rule: Pick<RecurrenceRule, "until">, anchor: string): string | null {
  if (rule.until !== undefined && rule.until !== null && rule.until < anchor)
    return `The repeat ends (${rule.until}) before the todo's date (${anchor}).`;
  return null;
}

/** The first date after `after` that matches a schedule rule (counted from the anchor). */
function nextMatch(rule: RecurrenceRule, anchor: string, after: string): string {
  const interval = rule.interval;
  switch (rule.every) {
    case "day": {
      const steps = Math.floor(daysBetween(anchor, after) / interval) + 1;
      return addDays(anchor, Math.max(1, steps) * interval);
    }
    case "week": {
      const days = new Set((rule.weekdays ?? [weekdayOf(anchor)]).map((w) => WEEKDAYS.indexOf(w)));
      const anchorMonday = addDays(anchor, -weekdayIndex(anchor));
      // Jump to the week of `after`, then walk day by day (at most interval weeks plus one).
      let date = addDays(after, 1);
      for (let i = 0; i < 7 * (interval + 1); i += 1) {
        const week = Math.floor(daysBetween(anchorMonday, date) / 7);
        if (week >= 0 && week % interval === 0 && days.has(weekdayIndex(date))) return date;
        date = addDays(date, 1);
      }
      throw new Error("unreachable: no weekly match");
    }
    case "month": {
      const start = monthIndex(parse(anchor));
      const offset = monthIndex(parse(after)) - start;
      let k = Math.max(0, Math.floor(offset / interval));
      for (;;) {
        const { y, m } = fromMonthIndex(start + k * interval);
        const date = rule.monthWeekday
          ? nthWeekdayDate(y, m, rule.monthWeekday.nth, rule.monthWeekday.weekday)
          : monthDate(y, m, rule.monthDay ?? parse(anchor).d);
        if (date > after) return date;
        k += 1;
      }
    }
    case "year": {
      const start = parse(anchor).y;
      const yearDate = rule.yearDate ?? anchor.slice(5);
      let k = Math.max(0, Math.floor((parse(after).y - start) / interval));
      for (;;) {
        const date = yearDateIn(start + k * interval, yearDate);
        if (date > after) return date;
        k += 1;
      }
    }
  }
}

export interface OccurrenceInput {
  /** The current occurrence's date (due date, else planned day). */
  anchor: string;
  /** Local date the todo was marked done. */
  doneOn: string;
  /** Local date today. */
  today: string;
}

/**
 * The date of the next occurrence, or null when it would be after `until`. schedule: the first
 * matching date after the anchor; dates before today are skipped (no backlog of missed ones).
 * done: doneOn plus the interval.
 */
export function nextOccurrence(rule: RecurrenceRuleInput, input: OccurrenceInput): string | null {
  const full = normalizeRecurrence(rule, input.anchor);
  let next: string;
  if (full.basis === "done") {
    const n = full.interval;
    next =
      full.every === "day"
        ? addDays(input.doneOn, n)
        : full.every === "week"
          ? addDays(input.doneOn, 7 * n)
          : addMonthsClamped(input.doneOn, full.every === "month" ? n : 12 * n);
  } else {
    next = nextMatch(full, input.anchor, input.anchor);
    if (next < input.today) {
      // Jump close to today in one step, then take the first match from there.
      next = nextMatch(full, input.anchor, addDays(input.today, -1));
    }
  }
  if (full.until !== undefined && full.until !== null && next > full.until) return null;
  return next;
}

export interface TodoDates {
  dueOn: string | null;
  plannedOn: string | null;
}

/** Moves due and planned date by the same number of days, so the anchor lands on `next`. */
export function shiftTodoDates(dates: TodoDates, next: string): TodoDates {
  const anchor = dates.dueOn ?? dates.plannedOn;
  if (anchor === null) return { dueOn: null, plannedOn: null };
  const delta = daysBetween(anchor, next);
  return {
    dueOn: dates.dueOn === null ? null : addDays(dates.dueOn, delta),
    plannedOn: dates.plannedOn === null ? null : addDays(dates.plannedOn, delta),
  };
}

const WEEKDAY_NAMES: Record<Weekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};
const WEEKDAY_LONG: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

const ORDINAL_SUFFIX: Record<number, string> = { 1: "st", 2: "nd", 3: "rd" };

/** 1st, 2nd, 3rd, 4th, 11th, 21st, ... */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  const suffix = ORDINAL_SUFFIX[n % 10] ?? "th";
  return `${n}${suffix}`;
}

/** "every 3 days", "every week", "every 2 months". */
function everyText(unit: RecurrenceUnit, interval: number): string {
  return interval === 1 ? `every ${unit}` : `every ${interval} ${unit}s`;
}

const WORKWEEK = ["mon", "tue", "wed", "thu", "fri"];

/**
 * The rule in plain words: "every day", "every weekday", "every 2 weeks on Mon, Thu", "every month
 * on the 15th", "every month on the last day", "every month on the 2nd Tuesday", "every year on
 * 03-14", "every 3 days after done", plus " until 2026-12-31".
 */
export function describeRecurrence(rule: RecurrenceRuleInput): string {
  const interval = rule.interval ?? 1;
  let text = everyText(rule.every, interval);
  if (rule.basis === "done") {
    text += " after done";
  } else if (rule.every === "week" && rule.weekdays) {
    const days = rule.weekdays.toSorted((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
    if (interval === 1 && days.join() === WORKWEEK.join()) text = "every weekday";
    else text += ` on ${days.map((d) => WEEKDAY_NAMES[d]).join(", ")}`;
  } else if (rule.every === "month" && rule.monthWeekday) {
    const { nth, weekday } = rule.monthWeekday;
    text += ` on the ${nth === -1 ? "last" : ordinal(nth)} ${WEEKDAY_LONG[weekday]}`;
  } else if (rule.every === "month" && rule.monthDay !== undefined) {
    text += rule.monthDay === -1 ? " on the last day" : ` on the ${ordinal(rule.monthDay)}`;
  } else if (rule.every === "year" && rule.yearDate) {
    text += ` on ${rule.yearDate}`;
  }
  if (rule.until) text += ` until ${rule.until}`;
  return text;
}
