import { z } from "zod";
import { NoteSummary, ProjectRef, TodoRef } from "./entities.ts";
import { Instant } from "./planner.ts";
import {
  CalendarDate,
  commaList,
  type EventKind,
  Id,
  IdParam,
  QueryBoolean,
  Timestamp,
} from "./primitives.ts";
import { RecurrenceRule } from "./recurrence.ts";
import { OCCURRENCE_STATUSES } from "./series.ts";

/**
 * Meetings: a name, a repeating schedule (series segments) and a type. Standups have a list of what the
 * user has not said yet, worked out from the todos' activity; each date can have a note.
 */

export const MEETING_TYPES = ["standup", "other"] as const;
export const MeetingType = z.enum(MEETING_TYPES);
export type MeetingType = z.infer<typeof MeetingType>;

/** Standup for names like "Standup", "Daily" or "Scrum", else other (the web app preselects with it). */
export const suggestMeetingType = (name: string): MeetingType =>
  /stand-?up|daily|scrum/i.test(name) ? "standup" : "other";

export const TimeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 09:00 (HH:MM, 24 hours).");

/** A meeting's repeat: a schedule rule (never counted from a done date). */
export const SeriesRule = RecurrenceRule.refine((rule) => rule.basis === "schedule", {
  message: "A meeting repeats on a schedule, not counted from a done date.",
  path: ["basis"],
});

export const MIN_MEETING_MINUTES = 5;
export const MAX_MEETING_MINUTES = 1440;

const Duration = z
  .number()
  .int()
  .min(MIN_MEETING_MINUTES, "A meeting lasts at least 5 minutes.")
  .max(MAX_MEETING_MINUTES, "A meeting lasts at most 24 hours.");

/** The schedule of a new meeting. A rule's `until` becomes the last date (endsOn wins when both are sent). */
export const SeriesInput = z
  .strictObject({
    rule: SeriesRule,
    /** The first date; also the anchor of the rule. */
    startsOn: CalendarDate,
    /** The last possible date; null or left out = no end. */
    endsOn: CalendarDate.nullable().optional(),
    startTime: TimeOfDay,
    durationMinutes: Duration,
  })
  .refine((v) => v.endsOn === undefined || v.endsOn === null || v.endsOn >= v.startsOn, {
    message: "The repeat must not end before its first date.",
    path: ["endsOn"],
  });
export type SeriesInput = z.infer<typeof SeriesInput>;

const IdList = (what: string) =>
  z
    .array(Id)
    .max(50, `Pick at most 50 ${what}.`)
    .transform((ids) => [...new Set(ids)]);

/**
 * Which todos a standup looks at: in one of the projects (or in the Inbox when inbox is set) and with
 * any one of the labels. Empty lists = no limit, so the default is everything in the account.
 */
export const StandupFilter = z.strictObject({
  projectIds: IdList("projects").default([]),
  inbox: z.boolean().default(false),
  labelIds: IdList("labels").default([]),
});
export type StandupFilter = z.infer<typeof StandupFilter>;

const MeetingName = z
  .string()
  .trim()
  .min(1, "Give the meeting a name.")
  .max(200, "Keep the name at 200 characters or fewer.");

export const CreateMeeting = z.strictObject({
  name: MeetingName,
  /** Left out: suggestMeetingType(name). */
  type: MeetingType.optional(),
  schedule: SeriesInput,
  filter: StandupFilter.optional(),
  /** The standup list counts activity from the start of this day; left out: from the last meeting date. */
  countFrom: CalendarDate.optional(),
});
export type CreateMeeting = z.infer<typeof CreateMeeting>;
export type CreateMeetingInput = z.input<typeof CreateMeeting>;

export const UpdateMeeting = z
  .strictObject({
    name: MeetingName.optional(),
    type: MeetingType.optional(),
    filter: StandupFilter.optional(),
    countFrom: CalendarDate.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Send at least one field to change.");
export type UpdateMeeting = z.infer<typeof UpdateMeeting>;

export const SERIES_SCOPES = ["this", "following", "all"] as const;
export const SeriesScope = z.enum(SERIES_SCOPES);
export type SeriesScope = z.infer<typeof SeriesScope>;

/**
 * A change of the repeat from an original date on: "following" splits the segment there, "all" changes
 * the segment that holds the date (a segment that starts later stays as it is).
 */
export const ScheduleChange = z
  .strictObject({
    scope: z.enum(["following", "all"]),
    /** An original date of the meeting. */
    from: CalendarDate,
    rule: SeriesRule.optional(),
    startTime: TimeOfDay.optional(),
    durationMinutes: Duration.optional(),
    endsOn: CalendarDate.nullable().optional(),
  })
  .refine(
    (v) =>
      v.rule !== undefined ||
      v.startTime !== undefined ||
      v.durationMinutes !== undefined ||
      v.endsOn !== undefined,
    "Send at least one field to change.",
  );
export type ScheduleChange = z.infer<typeof ScheduleChange>;

/** Start before end, 5 minutes to 24 hours. */
function checkMeetingSpan(ctx: z.RefinementCtx, startAt: string, endAt: string): void {
  const minutes = (Date.parse(endAt) - Date.parse(startAt)) / 60_000;
  if (minutes <= 0)
    ctx.addIssue({ code: "custom", message: "The meeting must end after it starts.", path: ["endAt"] });
  else if (minutes < MIN_MEETING_MINUTES || minutes > MAX_MEETING_MINUTES)
    ctx.addIssue({
      code: "custom",
      message: "A meeting lasts at least 5 minutes and at most 24 hours.",
      path: ["endAt"],
    });
}

/**
 * A change of one date (the path names its original date): move it (this one, this and following, or
 * all of its segment), cancel it (this one, or this and following = the repeat ends the day before), or
 * undo a single date's change (cancelled false). Cancelling all is deleting the meeting.
 */
export const OccurrenceChange = z.union([
  z
    .strictObject({ scope: SeriesScope, startAt: Instant, endAt: Instant })
    .superRefine((v, ctx) => checkMeetingSpan(ctx, v.startAt, v.endAt)),
  z.strictObject({ scope: z.enum(["this", "following"]), cancelled: z.literal(true) }),
  z.strictObject({ scope: z.literal("this"), cancelled: z.literal(false) }),
]);
export type OccurrenceChange = z.infer<typeof OccurrenceChange>;

/** One segment of a meeting's repeat. */
export const Series = z.strictObject({
  id: Id,
  rule: RecurrenceRule,
  startsOn: CalendarDate,
  endsOn: CalendarDate.nullable(),
  startTime: TimeOfDay,
  durationMinutes: z.number().int(),
  /** "every week on Thu, 09:00–09:15". */
  text: z.string(),
});
export type Series = z.infer<typeof Series>;

export const OccurrenceStatus = z.enum(OCCURRENCE_STATUSES);
export type OccurrenceStatus = z.infer<typeof OccurrenceStatus>;

export const MeetingOccurrence = z.strictObject({
  meetingId: Id,
  seriesId: Id,
  name: z.string(),
  type: MeetingType,
  /** The original date (the key of the note and of moves). */
  occursOn: CalendarDate,
  startAt: Timestamp,
  endAt: Timestamp,
  status: OccurrenceStatus,
  /** The note of this date, if any. */
  noteId: Id.nullable(),
});
export type MeetingOccurrence = z.infer<typeof MeetingOccurrence>;

export const Meeting = z.strictObject({
  id: Id,
  name: z.string(),
  type: MeetingType,
  filter: z.strictObject({ projectIds: z.array(Id), inbox: z.boolean(), labelIds: z.array(Id) }),
  /** The standup list counts activity after this instant. */
  since: Timestamp,
  /** The segment that holds today, else the next one, else the last one. */
  schedule: Series,
  /** Every segment, by first date. */
  segments: z.array(Series),
  /** The next occurrence that has not ended (cancelled ones skipped), or null. */
  next: MeetingOccurrence.nullable(),
  /** Items still to say (standups only), else null. */
  openCount: z.number().int().nonnegative().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Meeting = z.infer<typeof Meeting>;

/** Days in the account's time zone, both included; at most 62 days. */
export const OccurrenceQuery = z
  .strictObject({
    from: CalendarDate,
    to: CalendarDate,
    meetingId: IdParam.optional(),
    /** true = cancelled dates too (status "cancelled"). */
    cancelled: QueryBoolean.optional(),
  })
  .refine((v) => v.to >= v.from, { message: "to must not be before from.", path: ["to"] })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 62, {
    message: "Ask for at most 62 days at once.",
    path: ["to"],
  });
export type OccurrenceQuery = z.infer<typeof OccurrenceQuery>;

export const MeetingDateParams = z.strictObject({ id: IdParam, on: CalendarDate });
export type MeetingDateParams = z.infer<typeof MeetingDateParams>;

export const MarkParams = z.strictObject({ id: IdParam, on: CalendarDate, todoId: IdParam });
export type MarkParams = z.infer<typeof MarkParams>;

// ---------- the standup list ----------

/** Groups of the list, in the order it shows them. */
export const STANDUP_KINDS = ["done", "started", "updated", "blocked"] as const;
export const StandupKind = z.enum(STANDUP_KINDS);
export type StandupKind = z.infer<typeof StandupKind>;

/**
 * History events that count as an update of a started or blocked todo (comments count too). Only due
 * date, label, project or repeat changes do not.
 */
export const STANDUP_UPDATE_KINDS = [
  "title_changed",
  "description_changed",
  "status_changed",
  "checklist_changed",
  "subtasks_changed",
  "links_changed",
  "people_changed",
  "parent_changed",
] as const satisfies readonly EventKind[];

export const StandupComment = z.strictObject({
  actor: z.string(),
  /** The first 200 characters as plain text. */
  excerpt: z.string(),
  createdAt: Timestamp,
});
export type StandupComment = z.infer<typeof StandupComment>;

export const StandupItem = z.strictObject({
  todo: TodoRef,
  project: ProjectRef.nullable(),
  /** The parent, for a subtask. */
  parent: TodoRef.nullable(),
  kind: StandupKind,
  /** The newest activity that put it on the list (the done time for done todos). */
  at: Timestamp,
  /** Up to 5 short sentences about what changed, newest first ("changed status from Open to In progress"). */
  changes: z.array(z.string()),
  newCommentCount: z.number().int().nonnegative(),
  lastComment: StandupComment.nullable(),
  /** It was said or dismissed at this standup before and has news since. */
  again: z.boolean(),
});
export type StandupItem = z.infer<typeof StandupItem>;

export const StandupCounts = z.strictObject({
  done: z.number().int().nonnegative(),
  started: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
});
export type StandupCounts = z.infer<typeof StandupCounts>;

export const SaidItem = z.strictObject({
  todo: TodoRef,
  project: ProjectRef.nullable(),
  markedAt: Timestamp,
});
export type SaidItem = z.infer<typeof SaidItem>;

export const Standup = z.strictObject({
  meetingId: Id,
  /** The meeting date the marks go to. */
  on: CalendarDate,
  since: Timestamp,
  /** By group (done, started, updated, blocked), newest first in each; only the asked kinds. */
  items: z.array(StandupItem),
  /** Items per kind, whatever kinds were asked. */
  counts: StandupCounts,
  /** Todos said on this date, newest first. */
  said: z.array(SaidItem),
  dismissedCount: z.number().int().nonnegative(),
});
export type Standup = z.infer<typeof Standup>;

export const StandupQuery = z.strictObject({
  /** Default: the next meeting date on or after today. */
  on: CalendarDate.optional(),
  /** Comma list of kinds; default all. */
  kind: commaList(StandupKind).optional(),
});
export type StandupQuery = z.infer<typeof StandupQuery>;

export const MARK_KINDS = ["said", "dismissed"] as const;
export const MarkKind = z.enum(MARK_KINDS);
export type MarkKind = z.infer<typeof MarkKind>;

export const MarkInput = z.strictObject({
  /** The meeting date the marks belong to. */
  on: CalendarDate,
  marks: z
    .array(
      z.strictObject({
        todoId: Id,
        kind: MarkKind,
        /** The item's `at` as the list showed it: activity up to this time is covered. */
        coveredUntil: Instant,
      }),
    )
    .min(1, "Send at least one mark.")
    .max(200, "Send at most 200 marks at once.")
    .refine((marks) => new Set(marks.map((m) => m.todoId)).size === marks.length, "Mark each todo once."),
});
export type MarkInput = z.infer<typeof MarkInput>;

/** Without noteId a new note is written for the date; with it, that note is linked. */
export const MeetingNoteInput = z.strictObject({ on: CalendarDate, noteId: Id.optional() });
export type MeetingNoteInput = z.infer<typeof MeetingNoteInput>;

export const MeetingNote = z.strictObject({ meetingId: Id, on: CalendarDate, note: NoteSummary });
export type MeetingNote = z.infer<typeof MeetingNote>;
