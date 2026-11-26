import { z } from "zod";
import { Todo } from "./entities.ts";
import { Color, Id, PROJECT_COLORS, Slug, Timestamp } from "./primitives.ts";

/**
 * Shared projects: a project several accounts work on together. Its data lives in a space (a hidden
 * account); members open it in the web app under /u/<username>/shared/<id>, where every API call carries
 * the SPACE_HEADER. The Sloppanizer project (system "feedback") collects bug reports and feature
 * requests from every user; all admins are its members.
 */

/** Names the space a request acts in (its id). Members send it from the web app, or with an API token of their own account (MCP). */
export const SPACE_HEADER = "x-sloppanizer-space";

export const SPACE_ROLES = ["owner", "member"] as const;
export const SpaceRole = z.enum(SPACE_ROLES);
export type SpaceRole = z.infer<typeof SpaceRole>;

/** Labels of feedback todos, one per kind. */
export const FEEDBACK_KINDS = ["bug", "feature"] as const;
export const FeedbackKind = z.enum(FEEDBACK_KINDS);
export type FeedbackKind = z.infer<typeof FeedbackKind>;
export const FEEDBACK_LABELS: Record<FeedbackKind, { name: string; color: string }> = {
  bug: { name: "type::bug", color: "#F2555A" },
  feature: { name: "type::feature", color: "#4C9AFF" },
};

export const SpaceMember = z.strictObject({
  accountId: Id,
  username: z.string(),
  /** "First Last" when the account has a name, else the username. */
  name: z.string(),
  role: SpaceRole,
  /** When they were added (they have access from then on); null for the admins of the Sloppanizer project. */
  addedAt: Timestamp.nullable(),
});
export type SpaceMember = z.infer<typeof SpaceMember>;

export const Space = z.strictObject({
  id: Id,
  name: z.string(),
  color: Color,
  /** "feedback" for the Sloppanizer project, else null. */
  system: z.literal("feedback").nullable(),
  /** The slug of its project (the page members land on). */
  projectSlug: Slug.nullable(),
  openCount: z.number().int().nonnegative(),
  /** Your role: owners rename it, manage members and delete it. Admins own the Sloppanizer project. */
  role: SpaceRole,
  members: z.array(SpaceMember),
  createdAt: Timestamp,
});
export type Space = z.infer<typeof Space>;

const SpaceName = z.string().trim().min(1, "Enter a name.").max(100);
const Username = z.string().trim().toLowerCase().min(1).max(32);

export const CreateSpace = z.strictObject({
  name: SpaceName,
  color: z.enum(PROJECT_COLORS).optional(),
  /** Usernames to add as members. */
  members: z.array(Username).max(50).optional(),
});
export type CreateSpace = z.infer<typeof CreateSpace>;

export const UpdateSpace = z
  .strictObject({ name: SpaceName.optional(), color: z.enum(PROJECT_COLORS).optional() })
  .refine((value) => value.name !== undefined || value.color !== undefined, "Send a name or a color.");
export type UpdateSpace = z.infer<typeof UpdateSpace>;

export const AddSpaceMember = z.strictObject({ username: Username });
export type AddSpaceMember = z.infer<typeof AddSpaceMember>;

/**
 * Moves a todo (with its subtasks) to another account: a shared project, or back to your own todos. Todos
 * never change accounts, so it is copied there (thread, checklist, subtasks, labels, people, web links,
 * files) and the original is marked done with a comment naming the copy. Sent from where the todo is.
 */
export const MoveTodo = z.strictObject({
  /** The shared project to move it to; null: your own todos. */
  spaceId: Id.nullable(),
  /** A project there. Default: the shared project's own; in your own todos, the Inbox. */
  projectId: Id.nullable().optional(),
});
export type MoveTodo = z.infer<typeof MoveTodo>;

export const MovedTodo = z.strictObject({
  /** Where the copy is: a shared project's id, or null for your own todos. */
  spaceId: Id.nullable(),
  /** The copy, in the account it moved to. */
  todo: Todo,
  /** How to name the copy: "S7#12" in a shared project, "#12" in your own todos. */
  ref: z.string(),
  /** The original, now done. */
  original: Todo,
});
export type MovedTodo = z.infer<typeof MovedTodo>;

export const SpaceMemberParams = z.strictObject({
  id: z.coerce.number().int().positive(),
  accountId: z.coerce.number().int().positive(),
});

export const CreateFeedback = z.strictObject({
  kind: FeedbackKind,
  title: z.string().trim().min(1, "Enter a title.").max(200),
  description: z.string().max(20_000).optional(),
  /** Where it happened (the page path), added to the description. */
  page: z.string().max(500).optional(),
});
export type CreateFeedback = z.infer<typeof CreateFeedback>;

export const FeedbackResult = z.strictObject({ id: Id });
export type FeedbackResult = z.infer<typeof FeedbackResult>;

/** "First Last" (either one alone) when set, else the username. */
export function personLabel(account: { firstName: string; lastName: string; username: string }): string {
  const name = [account.firstName.trim(), account.lastName.trim()].filter(Boolean).join(" ");
  return name || account.username;
}
