import { z } from "zod";
import { daysBetween } from "./dates.ts";
import { ProjectRef } from "./entities.ts";
import { CalendarDate, Id } from "./primitives.ts";

/**
 * Statistics of work over a period (#18). There is no timer, so "worked" is planned time that has already
 * happened: time blocks and planned dates of repeating todos, cut to the period and to now. Days, weeks
 * (Monday first) and hours are in the account's time zone.
 */

export const MAX_STATS_DAYS = 366;

export const WorkStatsQuery = z
  .strictObject({ from: CalendarDate, to: CalendarDate })
  .refine((v) => v.to >= v.from, { message: "to must not be before from.", path: ["to"] })
  .refine((v) => daysBetween(v.from, v.to) < MAX_STATS_DAYS, {
    message: `Ask for at most ${MAX_STATS_DAYS} days at once.`,
    path: ["to"],
  });
export type WorkStatsQuery = z.infer<typeof WorkStatsQuery>;

const Minutes = z.number().int().nonnegative();
const Count = z.number().int().nonnegative();

/** How long done todos took from created to done. */
export const DONE_BUCKETS = ["day", "3days", "week", "2weeks", "4weeks", "longer"] as const;
export const DoneBucket = z.enum(DONE_BUCKETS);
export type DoneBucket = z.infer<typeof DoneBucket>;
/** Upper limits of the buckets in days ("longer" has none). */
export const DONE_BUCKET_DAYS: Record<Exclude<DoneBucket, "longer">, number> = {
  day: 1,
  "3days": 3,
  week: 7,
  "2weeks": 14,
  "4weeks": 28,
};

export function doneBucket(ms: number): DoneBucket {
  const days = ms / 86_400_000;
  for (const bucket of DONE_BUCKETS) {
    if (bucket === "longer") break;
    if (days < DONE_BUCKET_DAYS[bucket]) return bucket;
  }
  return "longer";
}

/** Where worked time and done todos belong: a project, the Inbox, or blocks with only a title. */
export const StatsGroup = z.strictObject({
  kind: z.enum(["project", "inbox", "untitled"]),
  project: ProjectRef.nullable(),
  minutes: Minutes,
  done: Count,
});
export type StatsGroup = z.infer<typeof StatsGroup>;

export const RequesterStats = z.strictObject({
  person: z.strictObject({ id: Id, name: z.string() }),
  minutes: Minutes,
  done: Count,
});
export type RequesterStats = z.infer<typeof RequesterStats>;

export const WeekStats = z.strictObject({
  /** The Monday. */
  start: CalendarDate,
  workedMinutes: Minutes,
  meetingMinutes: Minutes,
  created: Count,
  done: Count,
  /** Worked minutes per project of this week, most first ("Inbox", "Own title" for the others). */
  projects: z.array(z.strictObject({ name: z.string(), minutes: Minutes })),
});
export type WeekStats = z.infer<typeof WeekStats>;

export const WorkStats = z.strictObject({
  from: CalendarDate,
  to: CalendarDate,
  totals: z.strictObject({
    workedMinutes: Minutes,
    meetingMinutes: Minutes,
    created: Count,
    done: Count,
    /** Median time from created to done of the todos done in the period, or null. */
    medianDoneMs: z.number().nonnegative().nullable(),
  }),
  /** Most worked first; groups with neither time nor done todos are left out. */
  projects: z.array(StatsGroup),
  /** The 10 requesters with the most worked time (then done todos); a todo counts for each requester. */
  requesters: z.array(RequesterStats),
  /** The rest of the requesters together, or null when there are none. */
  otherRequesters: z.strictObject({ people: Count, minutes: Minutes, done: Count }).nullable(),
  weeks: z.array(WeekStats),
  /** Every day of the period. */
  days: z.array(z.strictObject({ date: CalendarDate, workedMinutes: Minutes, done: Count })),
  /** Worked minutes by weekday (0 = Monday) and hour: 7 rows of 24. */
  hours: z.array(z.array(Minutes).length(24)).length(7),
  doneDurations: z.array(z.strictObject({ bucket: DoneBucket, count: Count })),
});
export type WorkStats = z.infer<typeof WorkStats>;
