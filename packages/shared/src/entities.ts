import { z } from "zod";
import { CalendarDate, Color, Id, Slug, Timestamp, TodoStatus, TokenScope } from "./primitives.ts";

export const Health = z.strictObject({ ok: z.literal(true), version: z.string() });
export type Health = z.infer<typeof Health>;

export const Me = z.strictObject({
  /** "you" for the browser session, else the token name. */
  actor: z.string(),
  via: z.enum(["session", "token"]),
  scope: TokenScope,
});
export type Me = z.infer<typeof Me>;

export const Project = z.strictObject({
  id: Id,
  slug: Slug,
  name: z.string(),
  description: z.string(),
  color: Color,
  archivedAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  openCount: z.number().int().nonnegative(),
});
export type Project = z.infer<typeof Project>;

export const Label = z.strictObject({
  id: Id,
  name: z.string(),
  scope: z.string().nullable(),
  value: z.string(),
  color: Color,
  description: z.string(),
  rank: z.number().int().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Label = z.infer<typeof Label>;

export const Person = z.strictObject({
  id: Id,
  firstName: z.string(),
  lastName: z.string(),
  note: z.string(),
  /** "First Last". */
  displayName: z.string(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Person = z.infer<typeof Person>;

export const ProjectRef = z.strictObject({ id: Id, slug: Slug, name: z.string(), color: Color });
export type ProjectRef = z.infer<typeof ProjectRef>;

export const Todo = z.strictObject({
  id: Id,
  projectId: Id.nullable(),
  parentId: Id.nullable(),
  title: z.string(),
  descriptionMd: z.string(),
  status: TodoStatus,
  dueOn: CalendarDate.nullable(),
  plannedOn: CalendarDate.nullable(),
  position: z.number(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  doneAt: Timestamp.nullable(),
  lastActivityAt: Timestamp,
  /** doneAt minus createdAt while done, else null. */
  durationMs: z.number().int().nonnegative().nullable(),
  /** Scoped labels first (by scope, then rank), then plain labels by name. */
  labels: z.array(Label),
  requestedBy: z.array(Person),
  project: ProjectRef.nullable(),
});
export type Todo = z.infer<typeof Todo>;

export const TodoPage = z.strictObject({
  items: z.array(Todo),
  /** Number of todos matching the filter, ignoring limit and offset. */
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type TodoPage = z.infer<typeof TodoPage>;

export const BulkUpdateResult = z.strictObject({ updated: z.array(Todo) });
export type BulkUpdateResult = z.infer<typeof BulkUpdateResult>;

export const REASON_KINDS = [
  "priority",
  "overdue",
  "due_today",
  "due_soon",
  "planned",
  "age",
  "idle",
  "in_progress",
] as const;
export const ReasonKind = z.enum(REASON_KINDS);
export type ReasonKind = z.infer<typeof ReasonKind>;

export const Reason = z.strictObject({ kind: ReasonKind, label: z.string(), points: z.number() });
export type Reason = z.infer<typeof Reason>;

export const NEXT_MODES = ["smart", "oldest", "priority", "due"] as const;
export const NextMode = z.enum(NEXT_MODES);
export type NextMode = z.infer<typeof NextMode>;

export const NextItem = z.strictObject({ todo: Todo, score: z.number(), reasons: z.array(Reason) });
export type NextItem = z.infer<typeof NextItem>;

export const NextUp = z.strictObject({
  mode: NextMode,
  today: CalendarDate,
  generatedAt: Timestamp,
  items: z.array(NextItem),
  blocked: z.array(Todo),
});
export type NextUp = z.infer<typeof NextUp>;

export const Stats = z.strictObject({
  open: z.number().int().nonnegative(),
  inProgress: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  doneLast7Days: z.number().int().nonnegative(),
  overdue: z.number().int().nonnegative(),
  dueToday: z.number().int().nonnegative(),
  plannedToday: z.number().int().nonnegative(),
  inbox: z.number().int().nonnegative(),
  lastExportAt: Timestamp.nullable(),
});
export type Stats = z.infer<typeof Stats>;

export const ApiToken = z.strictObject({
  id: Id,
  name: z.string(),
  /** First 12 characters of the raw token, for display. */
  prefix: z.string(),
  scope: TokenScope,
  createdAt: Timestamp,
  lastUsedAt: Timestamp.nullable(),
  expiresAt: Timestamp.nullable(),
  revokedAt: Timestamp.nullable(),
});
export type ApiToken = z.infer<typeof ApiToken>;

/** Returned once by POST /tokens; the raw value is never stored. */
export const CreatedToken = z.strictObject({ token: ApiToken, raw: z.string() });
export type CreatedToken = z.infer<typeof CreatedToken>;

/** Body of a 409 when a person with the same name exists. */
export const DuplicatePersonDetails = z.strictObject({ existing: Person });
export type DuplicatePersonDetails = z.infer<typeof DuplicatePersonDetails>;
