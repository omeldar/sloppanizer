import { z } from "zod";
import {
  CalendarDate,
  Color,
  EventKind,
  Id,
  SearchKind,
  Slug,
  Timestamp,
  TodoStatus,
  TokenScope,
} from "./primitives.ts";
import { RecurrenceRule } from "./recurrence.ts";

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

/** A person tag: the user's own judgment about a colleague ("fast reply"). Separate from todo labels. */
export const PersonTag = z.strictObject({
  id: Id,
  name: z.string(),
  color: Color,
  description: z.string(),
  peopleCount: z.number().int().nonnegative(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type PersonTag = z.infer<typeof PersonTag>;

/** What a person helps with ("firewall rules"). Created by typing, gone when no one has it. */
export const Topic = z.strictObject({
  id: Id,
  name: z.string(),
  peopleCount: z.number().int().nonnegative(),
});
export type Topic = z.infer<typeof Topic>;

/** A distinct team value (case-insensitive, first stored spelling). */
export const Team = z.strictObject({ name: z.string(), peopleCount: z.number().int().nonnegative() });
export type Team = z.infer<typeof Team>;

/** Todo counts of a person. "Open" means the active statuses (open, in progress, blocked). */
export const PersonCounts = z.strictObject({
  requested: z.number().int().nonnegative(),
  requestedOpen: z.number().int().nonnegative(),
  requestedDone: z.number().int().nonnegative(),
  contact: z.number().int().nonnegative(),
  contactOpen: z.number().int().nonnegative(),
});
export type PersonCounts = z.infer<typeof PersonCounts>;

/** The full person, from the /people endpoints. */
export const Person = z.strictObject({
  id: Id,
  firstName: z.string(),
  lastName: z.string(),
  /** Short one-line hint shown next to the name in pickers. */
  note: z.string(),
  /** "First Last". */
  displayName: z.string(),
  /** Team or department, free text ("" = none). */
  team: z.string(),
  /** "" = none. */
  email: z.string(),
  /** Long notes in Markdown. */
  notesMd: z.string(),
  /** Topic names (stored spelling), by name. */
  topics: z.array(z.string()),
  /** By name. */
  tags: z.array(PersonTag),
  counts: PersonCounts,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Person = z.infer<typeof Person>;

/** A person inside a todo: no tags, topics or notes. */
export const PersonBrief = z.strictObject({
  id: Id,
  firstName: z.string(),
  lastName: z.string(),
  displayName: z.string(),
  note: z.string(),
  team: z.string(),
  email: z.string(),
});
export type PersonBrief = z.infer<typeof PersonBrief>;

export const ProjectRef = z.strictObject({ id: Id, slug: Slug, name: z.string(), color: Color });
export type ProjectRef = z.infer<typeof ProjectRef>;

/** A small reference to another todo (parent, links, next occurrence). */
export const TodoRef = z.strictObject({ id: Id, title: z.string(), status: TodoStatus });
export type TodoRef = z.infer<typeof TodoRef>;

const DoneCount = z.strictObject({
  total: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
});

/** Links of a todo, each list by id. */
export const TodoLinks = z.strictObject({
  /** Todos this one blocks. */
  blocks: z.array(TodoRef),
  /** Todos that block this one. */
  blockedBy: z.array(TodoRef),
  relatesTo: z.array(TodoRef),
});
export type TodoLinks = z.infer<typeof TodoLinks>;

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
  /** By link time, then id. */
  requestedBy: z.array(PersonBrief),
  /** People to ask about this todo; by link time, then id. */
  contacts: z.array(PersonBrief),
  commentCount: z.number().int().nonnegative(),
  project: ProjectRef.nullable(),
  /** The parent todo when this is a subtask. */
  parent: TodoRef.nullable(),
  /** subtasks: direct children; checklist: task list lines in descriptionMd. */
  progress: z.strictObject({ subtasks: DoneCount, checklist: DoneCount }),
  links: TodoLinks,
  /** The repeat rule (stored normalized), or null. */
  recurrence: RecurrenceRule.nullable(),
  /** The occurrence this todo was created from. */
  previousOccurrenceId: Id.nullable(),
  /** The todo created from this one when it was marked done. */
  nextOccurrence: TodoRef.nullable(),
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
  "blocks",
  "waiting",
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

/** Body of the 409 "ambiguous person, use personId" from todo writes: the short form of each namesake. */
export const AmbiguousPersonDetails = z.strictObject({ candidates: z.array(PersonBrief) });
export type AmbiguousPersonDetails = z.infer<typeof AmbiguousPersonDetails>;

/** Body of a 409 when a person with the same name exists. */
export const DuplicatePersonDetails = z.strictObject({ existing: Person });
export type DuplicatePersonDetails = z.infer<typeof DuplicatePersonDetails>;

export const Comment = z.strictObject({
  id: Id,
  todoId: Id,
  actor: z.string(),
  bodyMd: z.string(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  editedAt: Timestamp.nullable(),
});
export type Comment = z.infer<typeof Comment>;

/**
 * One history entry of a todo, normalized by the server: description_changed carries
 * { fromChars, toChars }, project_changed { from, to } as { id, name|null }|null (name null =
 * project deleted), people_changed { role, from, to } with people as { id, name }.
 */
export const ActivityEvent = z.strictObject({
  id: Id,
  todoId: Id,
  actor: z.string(),
  kind: EventKind,
  data: z.record(z.string(), z.unknown()),
  createdAt: Timestamp,
});
export type ActivityEvent = z.infer<typeof ActivityEvent>;

export const ActivityItem = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("comment"), comment: Comment }),
  z.strictObject({ type: z.literal("event"), event: ActivityEvent }),
]);
export type ActivityItem = z.infer<typeof ActivityItem>;

/** The thread of a todo, oldest first; same time: events before comments, then by id. */
export const Activity = z.strictObject({ todoId: Id, items: z.array(ActivityItem) });
export type Activity = z.infer<typeof Activity>;

export const Note = z.strictObject({
  id: Id,
  projectId: Id.nullable(),
  project: ProjectRef.nullable(),
  title: z.string(),
  bodyMd: z.string(),
  pinnedAt: Timestamp.nullable(),
  createdBy: z.string(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Note = z.infer<typeof Note>;

/** A note in lists: no body, but the first 200 characters of it as plain text. */
export const NoteSummary = Note.omit({ bodyMd: true }).extend({ excerpt: z.string() });
export type NoteSummary = z.infer<typeof NoteSummary>;

export const NotePage = z.strictObject({
  items: z.array(NoteSummary),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type NotePage = z.infer<typeof NotePage>;

export const Attachment = z.strictObject({
  id: Id,
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
  /** "/api/v1/attachments/<id>/<name>". */
  url: z.string(),
  /** true for png, jpeg, gif and webp (shown inline); everything else is a download. */
  inline: z.boolean(),
  createdBy: z.string(),
  createdAt: Timestamp,
});
export type Attachment = z.infer<typeof Attachment>;

export const SearchHit = z.strictObject({
  kind: SearchKind,
  id: Id,
  title: z.string(),
  snippet: z.string(),
  /** [start, end) character ranges in snippet that matched. Never HTML. */
  highlights: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])),
  /** Comments: their todo; todos: their own id; else null. */
  todoId: Id.nullable(),
  /** Todos only. */
  status: TodoStatus.nullable(),
  /** Person: team and topics; comment: actor and date; note: project name. */
  subtitle: z.string().nullable(),
});
export type SearchHit = z.infer<typeof SearchHit>;

export const SearchResult = z.strictObject({
  q: z.string(),
  items: z.array(SearchHit),
  /** Matches per kind, ignoring the limit. */
  counts: z.strictObject({
    todo: z.number().int().nonnegative(),
    note: z.number().int().nonnegative(),
    comment: z.number().int().nonnegative(),
    person: z.number().int().nonnegative(),
  }),
});
export type SearchResult = z.infer<typeof SearchResult>;

/** Body of a 409 when a topic rename hits another topic. */
export const TopicConflictDetails = z.strictObject({ existing: Topic });
export type TopicConflictDetails = z.infer<typeof TopicConflictDetails>;

/** Body of a 409 when a person tag name is taken. */
export const PersonTagConflictDetails = z.strictObject({ existing: PersonTag });
export type PersonTagConflictDetails = z.infer<typeof PersonTagConflictDetails>;

/** A task list line in a todo's description (`- [ ] text`). */
export const ChecklistItem = z.strictObject({
  /** 0-based position among the items. */
  index: z.number().int().nonnegative(),
  text: z.string(),
  checked: z.boolean(),
  /** 0-based line number in descriptionMd. */
  line: z.number().int().nonnegative(),
});
export type ChecklistItem = z.infer<typeof ChecklistItem>;

/** Body of the 409 when a label rename would give todos two labels of one scope. */
export const ScopeConflictDetails = z.strictObject({
  conflicts: z.array(z.strictObject({ todoId: Id, title: z.string(), labels: z.array(z.string()) })),
});
export type ScopeConflictDetails = z.infer<typeof ScopeConflictDetails>;

/** Body of the 409 when a checklist toggle is based on an old text. */
export const ChecklistStaleDetails = z.strictObject({ items: z.array(ChecklistItem) });
export type ChecklistStaleDetails = z.infer<typeof ChecklistStaleDetails>;

const Count = z.number().int().nonnegative();
const Millis = z.number().int().nonnegative();

/**
 * Numbers of one person in the filtered todo set. "open" = active statuses; speed (median, p90) is
 * doneAt minus createdAt of the done todos.
 */
export const PersonStat = z.strictObject({
  person: PersonBrief,
  requested: z.strictObject({
    total: Count,
    open: Count,
    done: Count,
    medianDoneMs: Millis.nullable(),
    p90DoneMs: Millis.nullable(),
    /** Days since the oldest open requested todo was created. */
    oldestOpenDays: Count.nullable(),
    /** Newest time this person was linked as requester to a todo in the set. */
    lastAt: Timestamp.nullable(),
  }),
  contact: z.strictObject({ total: Count, open: Count, done: Count }),
});
export type PersonStat = z.infer<typeof PersonStat>;

export const PeopleStats = z.strictObject({
  from: CalendarDate.nullable(),
  to: CalendarDate.nullable(),
  role: z.enum(["requester", "contact"]),
  /** Distinct todos linked to the listed people in the chosen role. */
  totals: z.strictObject({ todos: Count, open: Count, done: Count, medianDoneMs: Millis.nullable() }),
  items: z.array(PersonStat),
});
export type PeopleStats = z.infer<typeof PeopleStats>;

export const PersonStatMonth = z.strictObject({
  /** "YYYY-MM" in the server's time zone. */
  month: z.string(),
  /** Todos created that month with this person as requester. */
  requested: Count,
  /** Requested todos done that month. */
  done: Count,
  /** Todos created that month with this person as contact. */
  contact: Count,
});
export type PersonStatMonth = z.infer<typeof PersonStatMonth>;

/** One person's numbers plus the last 12 months (oldest first, months without todos included). */
export const PersonStatDetail = z.strictObject({ stat: PersonStat, months: z.array(PersonStatMonth) });
export type PersonStatDetail = z.infer<typeof PersonStatDetail>;

/** An export zip written to the export folder. */
export const FolderExport = z.strictObject({
  at: Timestamp,
  /** Full path of the zip inside WSL. */
  path: z.string(),
  fileName: z.string(),
  bytes: Count,
});
export type FolderExport = z.infer<typeof FolderExport>;

/** An entry of GET /export/folder: the full path only for the browser session (tokens do not see paths). */
export const FolderExportListItem = FolderExport.extend({ path: z.string().optional() });
export type FolderExportListItem = z.infer<typeof FolderExportListItem>;

export const Settings = z.strictObject({
  /** Fixed folder for "Write to folder": <data dir>/exports. */
  exportDir: z.string(),
  /** How many zips the export folder keeps (older ones are deleted after a write). */
  folderExportKeep: z.number().int().positive(),
  dataDir: z.string(),
  lastExportAt: Timestamp.nullable(),
  lastFolderExport: FolderExport.nullable(),
  version: z.string(),
});
export type Settings = z.infer<typeof Settings>;

/** A safety copy written before a restore. */
export const BackupFile = z.strictObject({ fileName: z.string(), createdAt: Timestamp, bytes: Count });
export type BackupFile = z.infer<typeof BackupFile>;

/** What a staged export zip holds, next to what the database holds now. */
export const RestorePreview = z.strictObject({
  uploadId: z.string(),
  fileName: z.string(),
  format: z.number().int().positive(),
  exportedAt: Timestamp,
  appVersion: z.string(),
  schemaVersion: z.number().int().nonnegative(),
  /** Rows per table. */
  inFile: z.record(z.string(), Count),
  now: z.record(z.string(), Count),
  attachments: z.strictObject({ count: Count, bytes: Count, missing: z.array(Id) }),
  warnings: z.array(z.string()),
  expiresAt: Timestamp,
});
export type RestorePreview = z.infer<typeof RestorePreview>;

export const RestoreResult = z.strictObject({
  restoredAt: Timestamp,
  counts: z.record(z.string(), Count),
  safetyCopy: BackupFile,
});
export type RestoreResult = z.infer<typeof RestoreResult>;

/** Body of the 422 when an export zip cannot be restored (the first 20 problems). */
export const RestoreProblemDetails = z.strictObject({ problems: z.array(z.string()) });
export type RestoreProblemDetails = z.infer<typeof RestoreProblemDetails>;
