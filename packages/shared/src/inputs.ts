import { z } from "zod";
import { findScopeConflicts, LabelName } from "./labels.ts";
import { normalizeTopic } from "./people.ts";
import { CalendarDate, Color, Id, Slug, Timestamp, TodoStatus, TokenScope } from "./primitives.ts";

const Title = z
  .string()
  .trim()
  .min(1, "Give the todo a title.")
  .max(300, "Keep the title at 300 characters or fewer.");
const Markdown = z.string().max(200_000, "Keep the description under 200000 characters.");
const PersonName = z.string().trim().min(1).max(100);
const LabelList = z.array(LabelName).max(50);

/** A person is referenced by id, or by name (find-or-create on a case-insensitive exact match). */
export const PersonRef = z.union([
  z.strictObject({ personId: Id }),
  z.strictObject({ firstName: PersonName, lastName: PersonName }),
]);
export type PersonRef = z.infer<typeof PersonRef>;
const PersonRefList = z.array(PersonRef).max(50);

/** Two labels of one scope in one request are a mistake (422). */
function checkScopes(ctx: z.RefinementCtx, names: readonly string[] | undefined, path: string): void {
  if (!names) return;
  for (const scope of findScopeConflicts(names)) {
    ctx.addIssue({
      code: "custom",
      path: [path],
      message: `Pick one label of scope "${scope}"; a todo has at most one label per scope.`,
    });
  }
}

function checkNotBoth(
  ctx: z.RefinementCtx,
  value: Record<string, unknown>,
  full: string,
  partial: readonly string[],
): void {
  if (value[full] === undefined) return;
  for (const key of partial) {
    if (value[key] !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `Send either ${full} (the full set) or ${key}, not both.`,
      });
    }
  }
}

function checkNotEmpty(ctx: z.RefinementCtx, value: Record<string, unknown>): void {
  if (Object.values(value).every((v) => v === undefined)) {
    ctx.addIssue({ code: "custom", message: "Send at least one field to change." });
  }
}

export const CreateTodo = z
  .strictObject({
    title: Title,
    descriptionMd: Markdown.optional(),
    status: TodoStatus.optional(),
    projectId: Id.nullable().optional(),
    dueOn: CalendarDate.nullable().optional(),
    plannedOn: CalendarDate.nullable().optional(),
    labels: LabelList.optional(),
    requestedBy: PersonRefList.optional(),
    /** People to ask about the todo; same rules as requestedBy. */
    contacts: PersonRefList.optional(),
  })
  .superRefine((value, ctx) => checkScopes(ctx, value.labels, "labels"));
export type CreateTodo = z.infer<typeof CreateTodo>;

export const UpdateTodo = z
  .strictObject({
    title: Title.optional(),
    descriptionMd: Markdown.optional(),
    status: TodoStatus.optional(),
    projectId: Id.nullable().optional(),
    dueOn: CalendarDate.nullable().optional(),
    plannedOn: CalendarDate.nullable().optional(),
    position: z.number().finite().optional(),
    labels: LabelList.optional(),
    addLabels: LabelList.optional(),
    removeLabels: LabelList.optional(),
    requestedBy: PersonRefList.optional(),
    addRequestedBy: PersonRefList.optional(),
    removeRequestedBy: PersonRefList.optional(),
    contacts: PersonRefList.optional(),
    addContacts: PersonRefList.optional(),
    removeContacts: PersonRefList.optional(),
  })
  .superRefine((value, ctx) => {
    checkNotEmpty(ctx, value);
    checkScopes(ctx, value.labels, "labels");
    checkScopes(ctx, value.addLabels, "addLabels");
    checkNotBoth(ctx, value, "labels", ["addLabels", "removeLabels"]);
    checkNotBoth(ctx, value, "requestedBy", ["addRequestedBy", "removeRequestedBy"]);
    checkNotBoth(ctx, value, "contacts", ["addContacts", "removeContacts"]);
  });
export type UpdateTodo = z.infer<typeof UpdateTodo>;

export const BulkPatch = z
  .strictObject({
    status: TodoStatus.optional(),
    projectId: Id.nullable().optional(),
    dueOn: CalendarDate.nullable().optional(),
    plannedOn: CalendarDate.nullable().optional(),
    addLabels: LabelList.optional(),
    removeLabels: LabelList.optional(),
  })
  .superRefine((value, ctx) => {
    checkNotEmpty(ctx, value);
    checkScopes(ctx, value.addLabels, "addLabels");
  });
export type BulkPatch = z.infer<typeof BulkPatch>;

export const BulkUpdate = z.strictObject({
  ids: z
    .array(Id)
    .min(1, "Send at least one id.")
    .max(200, "Update at most 200 todos at once.")
    .refine((ids) => new Set(ids).size === ids.length, "Each id may appear only once."),
  patch: BulkPatch,
});
export type BulkUpdate = z.infer<typeof BulkUpdate>;

const ProjectName = z.string().trim().min(1, "Give the project a name.").max(100);
const Description = z.string().max(2000);

export const CreateProject = z.strictObject({
  name: ProjectName,
  /** Derived from the name when left out. */
  slug: Slug.optional(),
  description: Description.optional(),
  color: Color.optional(),
});
export type CreateProject = z.infer<typeof CreateProject>;

export const UpdateProject = z
  .strictObject({
    name: ProjectName.optional(),
    slug: Slug.optional(),
    description: Description.optional(),
    color: Color.optional(),
    /** true archives (sets archivedAt), false restores. */
    archived: z.boolean().optional(),
  })
  .superRefine((value, ctx) => checkNotEmpty(ctx, value));
export type UpdateProject = z.infer<typeof UpdateProject>;

export const CreateLabel = z.strictObject({
  name: LabelName,
  color: Color.optional(),
  description: Description.optional(),
  rank: z.number().int().min(0).nullable().optional(),
});
export type CreateLabel = z.infer<typeof CreateLabel>;

export const UpdateLabel = z
  .strictObject({
    name: LabelName.optional(),
    color: Color.optional(),
    description: Description.optional(),
    rank: z.number().int().min(0).nullable().optional(),
    /**
     * When a rename moves the label into a scope that todos already have another label of: "fail"
     * (default) answers 409 with the todos, "replace" keeps this label and removes the others.
     */
    onScopeConflict: z.enum(["fail", "replace"]).optional(),
  })
  .superRefine((value, ctx) => checkNotEmpty(ctx, { ...value, onScopeConflict: undefined }));
export type UpdateLabel = z.infer<typeof UpdateLabel>;

const Team = z.string().trim().max(100, "Keep the team at 100 characters or fewer.");
/** An email address, or "" for none. */
const Email = z.union([
  z.literal(""),
  z.email("Use an email address like name@example.com, or an empty text for none.").max(254),
]);
const PersonNotes = z.string().max(200_000, "Keep the notes under 200000 characters.");

/** Topic name: trimmed, inner whitespace collapsed, 1..60 characters, no commas. */
export const TopicName = z
  .string()
  .transform(normalizeTopic)
  .pipe(
    z
      .string()
      .min(1, "Give the topic a name.")
      .max(60, "Keep topic names at 60 characters or fewer.")
      .refine(
        (name) => !name.includes(","),
        "Topic names cannot contain commas (filters use them as separators).",
      ),
  );
const TopicList = z.array(TopicName).max(50, "A person can have at most 50 topics.");

/** Person tag name: trimmed, 1..60 characters, no "::" (that is label syntax), no commas. */
export const PersonTagName = z
  .string()
  .trim()
  .min(1, "Give the tag a name.")
  .max(60, "Keep tag names at 60 characters or fewer.")
  .refine((name) => !name.includes("::"), 'Person tag names cannot contain "::".')
  .refine((name) => !name.includes(","), "Tag names cannot contain commas (filters use them as separators).");
const TagList = z.array(PersonTagName).max(30, "A person can have at most 30 tags.");

export const CreatePerson = z.strictObject({
  firstName: PersonName,
  lastName: PersonName,
  /** Short hint next to the name in pickers ("Platform team, Basel"). */
  note: Description.optional(),
  /** Create even when someone with the same first and last name exists. */
  allowDuplicate: z.boolean().optional(),
  team: Team.optional(),
  email: Email.optional(),
  notesMd: PersonNotes.optional(),
  /** Find-or-create by name. */
  topics: TopicList.optional(),
  /** Tags must exist (422 { unknownTags }). */
  tags: TagList.optional(),
});
export type CreatePerson = z.infer<typeof CreatePerson>;

export const UpdatePerson = z
  .strictObject({
    firstName: PersonName.optional(),
    lastName: PersonName.optional(),
    note: Description.optional(),
    team: Team.optional(),
    email: Email.optional(),
    notesMd: PersonNotes.optional(),
    topics: TopicList.optional(),
    addTopics: TopicList.optional(),
    removeTopics: TopicList.optional(),
    tags: TagList.optional(),
    addTags: TagList.optional(),
    removeTags: TagList.optional(),
  })
  .superRefine((value, ctx) => {
    checkNotEmpty(ctx, value);
    checkNotBoth(ctx, value, "topics", ["addTopics", "removeTopics"]);
    checkNotBoth(ctx, value, "tags", ["addTags", "removeTags"]);
  });
export type UpdatePerson = z.infer<typeof UpdatePerson>;

const TagDescription = z.string().max(2000);

export const CreatePersonTag = z.strictObject({
  name: PersonTagName,
  color: Color.optional(),
  description: TagDescription.optional(),
});
export type CreatePersonTag = z.infer<typeof CreatePersonTag>;

export const UpdatePersonTag = z
  .strictObject({
    name: PersonTagName.optional(),
    color: Color.optional(),
    description: TagDescription.optional(),
  })
  .superRefine((value, ctx) => checkNotEmpty(ctx, value));
export type UpdatePersonTag = z.infer<typeof UpdatePersonTag>;

/** Rename a topic; another topic with that name is a 409 (no silent merge). */
export const UpdateTopic = z.strictObject({ name: TopicName });
export type UpdateTopic = z.infer<typeof UpdateTopic>;

/** Markdown that must say something: 1..50000 characters, not only whitespace. Stored as sent. */
const CommentBody = z
  .string()
  .max(50_000, "Keep a comment under 50000 characters.")
  .refine((body) => body.trim().length > 0, "Write something before sending the comment.");

export const CreateComment = z.strictObject({ bodyMd: CommentBody });
export type CreateComment = z.infer<typeof CreateComment>;

export const UpdateComment = z.strictObject({ bodyMd: CommentBody });
export type UpdateComment = z.infer<typeof UpdateComment>;

const NoteTitle = z
  .string()
  .trim()
  .min(1, "Give the note a title.")
  .max(200, "Keep the title at 200 characters or fewer.");
const NoteBody = z.string().max(200_000, "Keep the note under 200000 characters.");

export const CreateNote = z.strictObject({
  title: NoteTitle,
  bodyMd: NoteBody.optional(),
  /** null or left out = no project. */
  projectId: Id.nullable().optional(),
  pinned: z.boolean().optional(),
});
export type CreateNote = z.infer<typeof CreateNote>;

export const UpdateNote = z
  .strictObject({
    title: NoteTitle.optional(),
    bodyMd: NoteBody.optional(),
    projectId: Id.nullable().optional(),
    /** true pins (keeps an earlier pin time), false unpins. */
    pinned: z.boolean().optional(),
  })
  .superRefine((value, ctx) => checkNotEmpty(ctx, value));
export type UpdateNote = z.infer<typeof UpdateNote>;

/** The actor name of the browser session; no token may use it. */
export const SESSION_ACTOR = "you";

export const CreateToken = z.strictObject({
  /** Unique among active tokens (case-insensitive); "you" is reserved for the browser session. */
  name: z
    .string()
    .trim()
    .min(1, "Give the token a name.")
    .max(100)
    .refine(
      (name) => name.toLowerCase() !== SESSION_ACTOR,
      'The name "you" is reserved for the browser session.',
    ),
  scope: TokenScope,
  expiresAt: Timestamp.nullable().optional(),
});
export type CreateToken = z.infer<typeof CreateToken>;

/** How two todos are linked: "blocks" (this one blocks the other), "blocked_by", or "relates". */
export const LINK_KINDS = ["blocks", "blocked_by", "relates"] as const;
export const LinkKind = z.enum(LINK_KINDS);
export type LinkKind = z.infer<typeof LinkKind>;

export const CreateLinks = z.strictObject({
  links: z
    .array(z.strictObject({ kind: LinkKind, todoId: Id }))
    .min(1, "Send at least one link.")
    .max(50, "Add at most 50 links at once."),
});
export type CreateLinks = z.infer<typeof CreateLinks>;

export const CreateSubtasks = z.strictObject({
  titles: z.array(Title).min(1, "Send at least one title.").max(50, "Add at most 50 subtasks at once."),
});
export type CreateSubtasks = z.infer<typeof CreateSubtasks>;

export const ToggleChecklist = z.strictObject({
  index: z.number().int().min(0),
  checked: z.boolean(),
  /** The item text the client saw; a different text means the checklist changed (409). */
  text: z.string().max(10_000).optional(),
});
export type ToggleChecklist = z.infer<typeof ToggleChecklist>;

export const ApplyRestore = z.strictObject({
  confirm: z.literal("replace", { error: 'Type "replace" to confirm.' }),
});
export type ApplyRestore = z.infer<typeof ApplyRestore>;
