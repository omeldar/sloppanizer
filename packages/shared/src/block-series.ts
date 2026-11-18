import { z } from "zod";
import { ProjectRef, Todo, TodoRef } from "./entities.ts";
import { OccurrenceStatus, Series, SeriesScope } from "./meetings.ts";
import { checkSpan, Instant } from "./planner.ts";
import { CalendarDate, Id, IdParam, QueryBoolean, Timestamp } from "./primitives.ts";
import type { RecurrenceRule } from "./recurrence.ts";

/**
 * Planned time that repeats with a repeating todo, like a repeating event in a calendar. A repeating
 * todo is a chain of todos: marking one done makes the next (recurrencePrevId points back). The planned
 * time belongs to the chain: its series is owned by the chain's open todo and moves along when the next
 * one is made. It has its own schedule rule, copied from the todo's repeat when it is planned, so its
 * dates can move (this one, this and following, all) without moving due dates. Whether a date is done
 * comes from the todo of that date, not from the series.
 */

/** The first planned date and time; the repeat follows the todo's rule from that date on. */
export const CreateBlockSeries = z
  .strictObject({ startAt: Instant, endAt: Instant })
  .superRefine((v, ctx) => checkSpan(ctx, v.startAt, v.endAt));
export type CreateBlockSeries = z.infer<typeof CreateBlockSeries>;

/**
 * A change of one planned date (the path names its original date): move it (this one, this and
 * following, or all of its part), cancel it (this one, or this and following = the repeat ends the day
 * before) or undo a single date's change. Cancelling all is DELETE of the planned time.
 */
export const BlockDateChange = z.union([
  z
    .strictObject({ scope: SeriesScope, startAt: Instant, endAt: Instant })
    .superRefine((v, ctx) => checkSpan(ctx, v.startAt, v.endAt)),
  z.strictObject({ scope: z.enum(["this", "following"]), cancelled: z.literal(true) }),
  z.strictObject({ scope: z.literal("this"), cancelled: z.literal(false) }),
]);
export type BlockDateChange = z.infer<typeof BlockDateChange>;

/** One date of a todo's planned time. */
export const BlockOccurrence = z.strictObject({
  seriesId: Id,
  /** The open todo of the repeat (where the planned time is changed). */
  ownerTodoId: Id,
  /** The todo of this date: an earlier, done one for past dates, else the open one. */
  todo: TodoRef,
  project: ProjectRef.nullable(),
  /** The original date (the key of moves and cancels). */
  occursOn: CalendarDate,
  startAt: Timestamp,
  endAt: Timestamp,
  status: OccurrenceStatus,
});
export type BlockOccurrence = z.infer<typeof BlockOccurrence>;

/** A repeating todo's planned time. */
export const BlockSeries = z.strictObject({
  /** The open todo of the repeat. */
  todoId: Id,
  /** The part that holds today, else the next one, else the last one. */
  schedule: Series,
  segments: z.array(Series),
  /** The next date that has not ended (cancelled ones skipped), or null. */
  next: BlockOccurrence.nullable(),
});
export type BlockSeries = z.infer<typeof BlockSeries>;

export const BlockOccurrenceQuery = z
  .strictObject({
    from: CalendarDate,
    to: CalendarDate,
    /** Any todo of the repeat. */
    todoId: IdParam.optional(),
    /** true = cancelled dates too (status "cancelled"). */
    cancelled: QueryBoolean.optional(),
  })
  .refine((v) => v.to >= v.from, { message: "to must not be before from.", path: ["to"] })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 62, {
    message: "Ask for at most 62 days at once.",
    path: ["to"],
  });
export type BlockOccurrenceQuery = z.infer<typeof BlockOccurrenceQuery>;

export const BlockDateParams = z.strictObject({ id: IdParam, on: CalendarDate });
export type BlockDateParams = z.infer<typeof BlockDateParams>;

/** A repeating todo as the Recurring view shows it: the open todo of the chain and its history. */
export const RecurringTodo = z.strictObject({
  /** The newest todo of the repeat: open, or done when the repeat has ended. */
  todo: Todo,
  /** "every week on Mon". */
  text: z.string(),
  /** The date of the open todo (due, else planned), or null when the repeat has ended. */
  nextOn: CalendarDate.nullable(),
  /** No next todo will come: the repeat is past its last date. */
  ended: z.boolean(),
  /** How many todos of the repeat are done, and when the last one was. */
  doneCount: z.number().int().nonnegative(),
  lastDoneAt: Timestamp.nullable(),
  /** The planned time that repeats with it, if any. */
  plan: BlockSeries.nullable(),
});
export type RecurringTodo = z.infer<typeof RecurringTodo>;

/** At most this many repeating todos are listed (an account rarely has more than a few dozen). */
export const MAX_RECURRING = 500;

/**
 * Whether a todo's repeat can carry planned time: a schedule repeat. One counted from the done date has
 * no fixed dates to plan ahead.
 */
export const canRepeatPlan = (rule: RecurrenceRule | null): boolean =>
  rule !== null && rule.basis === "schedule";

/**
 * The todo of the chain a planned date belongs to: the newest one whose date (due, else planned) is on
 * or before it, else the first. So a date after the open todo's belongs to the open one, and past dates
 * show whether their todo was done. `chain` is ordered oldest first; members without a date are skipped.
 */
export function todoForDate<T extends { anchor: string | null }>(
  chain: readonly T[],
  date: string,
): T | null {
  let found: T | null = null;
  for (const member of chain) {
    if (member.anchor === null) continue;
    if (member.anchor <= date) found = member;
    else if (found === null) return member;
    else break;
  }
  return found ?? chain.at(-1) ?? null;
}
