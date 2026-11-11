import { z } from "zod";
import { findScopeConflicts, LabelName } from "./labels.ts";
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
  })
  .superRefine((value, ctx) => {
    checkNotEmpty(ctx, value);
    checkScopes(ctx, value.labels, "labels");
    checkScopes(ctx, value.addLabels, "addLabels");
    checkNotBoth(ctx, value, "labels", ["addLabels", "removeLabels"]);
    checkNotBoth(ctx, value, "requestedBy", ["addRequestedBy", "removeRequestedBy"]);
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
  })
  .superRefine((value, ctx) => checkNotEmpty(ctx, value));
export type UpdateLabel = z.infer<typeof UpdateLabel>;

export const CreatePerson = z.strictObject({
  firstName: PersonName,
  lastName: PersonName,
  note: Description.optional(),
  /** Create even when someone with the same first and last name exists. */
  allowDuplicate: z.boolean().optional(),
});
export type CreatePerson = z.infer<typeof CreatePerson>;

export const UpdatePerson = z
  .strictObject({
    firstName: PersonName.optional(),
    lastName: PersonName.optional(),
    note: Description.optional(),
  })
  .superRefine((value, ctx) => checkNotEmpty(ctx, value));
export type UpdatePerson = z.infer<typeof UpdatePerson>;

export const CreateToken = z.strictObject({
  name: z.string().trim().min(1, "Give the token a name.").max(100),
  scope: TokenScope,
  expiresAt: Timestamp.nullable().optional(),
});
export type CreateToken = z.infer<typeof CreateToken>;
