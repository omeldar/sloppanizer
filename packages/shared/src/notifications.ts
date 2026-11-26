import { z } from "zod";
import { Id, QueryBoolean, Timestamp, TodoStatus } from "./primitives.ts";

/**
 * In-app notifications (S5#6): what happened to the user in a todo while they were elsewhere. Made by the
 * server when someone assigns them a shared todo, mentions them (@username) in a comment, comments on a
 * shared todo assigned to them, or marks a todo of theirs "action needed". Nobody is notified of what they
 * did themselves in the browser; what their API tokens (MCP clients, scheduled runs) do is notified.
 */

export const NOTIFICATION_KINDS = ["assigned", "mentioned", "commented", "action_needed"] as const;
export const NotificationKind = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof NotificationKind>;

export const Notification = z.strictObject({
  id: Id,
  kind: NotificationKind,
  /** Who did it, as the history names them. */
  actor: z.string(),
  /** The comment's first words, or the action needed reason; "" for an assignment. */
  excerpt: z.string(),
  todo: z.strictObject({
    id: Id,
    title: z.string(),
    status: TodoStatus,
    /** "#12" for an own todo, "S7#12" in shared project 7. */
    ref: z.string(),
  }),
  /** The shared project the todo is in, or null for an own todo. */
  space: z.strictObject({ id: Id, name: z.string() }).nullable(),
  createdAt: Timestamp,
  readAt: Timestamp.nullable(),
});
export type Notification = z.infer<typeof Notification>;

export const NotificationList = z.strictObject({
  /** Newest first. */
  items: z.array(Notification),
  unreadCount: z.number().int().nonnegative(),
});
export type NotificationList = z.infer<typeof NotificationList>;

export const NotificationQuery = z.strictObject({
  /** true = unread ones only. */
  unread: QueryBoolean.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type NotificationQuery = z.infer<typeof NotificationQuery>;

/** Marks some (ids) or all notifications read; read false marks them unread again. */
export const MarkNotifications = z
  .strictObject({
    ids: z.array(Id).min(1).max(200).optional(),
    all: z.literal(true).optional(),
    read: z.boolean().default(true),
  })
  .refine((v) => (v.ids === undefined) !== (v.all === undefined), "Send ids or all: true.");
export type MarkNotifications = z.infer<typeof MarkNotifications>;
export type MarkNotificationsInput = z.input<typeof MarkNotifications>;

/** How many notifications a user keeps: older read ones go first. */
export const MAX_NOTIFICATIONS = 200;

/** The usernames a comment mentions (@anna, @bo-2), lowercased, each once. */
export function mentionedUsernames(markdown: string): string[] {
  const out = new Set<string>();
  for (const match of markdown.matchAll(/(^|[^\w@./])@([a-z0-9][a-z0-9_.-]{0,31})/gi)) {
    out.add((match[2] as string).replace(/[.-]+$/, "").toLowerCase());
  }
  return [...out];
}
