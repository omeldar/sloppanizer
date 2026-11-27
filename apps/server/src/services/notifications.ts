import {
  MAX_NOTIFICATIONS,
  mentionedUsernames,
  type MarkNotifications,
  type Notification,
  type NotificationKind,
  type NotificationList,
  type NotificationQuery,
  type Todo,
} from "@organizer/shared";
import { and, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { accounts, spaceMembers, spaces } from "../db/auth-schema.ts";
import { notifications, todos } from "../db/schema.ts";
import type { Ctx, Scoped, Tx } from "./context.ts";
import { chunks } from "./sql.ts";
import { plainText } from "./text.ts";

/**
 * In-app notifications (shared notifications.ts). They are made in the same transaction as the change
 * that causes them and belong to the recipient's own account, whichever account the todo lives in.
 *
 * Who gets one: in a shared project the assignee (assigned, comments, action needed) and members named
 * with @username in a comment; an unassigned shared todo marked action needed notifies every member; an
 * own todo notifies its owner. Nobody is notified of what they did themselves in the browser, but what
 * their API tokens do is (a scheduled assistant run commenting or asking for action is the point).
 */

/** Kept in step with services/spaces.ts (FEEDBACK_KEY); not imported to keep the import graph flat. */
const FEEDBACK_KEY = "feedback";
const EXCERPT = 200;

/** Who acts: their own account and whether it is the browser (their own clicks are not notified). */
export interface Acting {
  callerId?: number;
  callerVia?: "session" | "token";
}

interface Member {
  id: number;
  username: string;
}

/** The members of the space (the active admins for the Sloppanizer project), or null for an own account. */
function membersOf(tx: Tx, accountId: number): Member[] | null {
  const space = tx.select().from(spaces).where(eq(spaces.accountId, accountId)).get();
  if (!space) return null;
  if (space.systemKey === FEEDBACK_KEY)
    return tx
      .select({ id: accounts.id, username: accounts.username })
      .from(accounts)
      .where(and(eq(accounts.role, "admin"), eq(accounts.status, "active"), eq(accounts.kind, "user")))
      .all();
  return tx
    .select({ id: accounts.id, username: accounts.username })
    .from(spaceMembers)
    .innerJoin(accounts, eq(accounts.id, spaceMembers.accountId))
    .where(and(eq(spaceMembers.spaceId, accountId), eq(accounts.status, "active")))
    .all();
}

interface NewNotification {
  recipientId: number;
  kind: NotificationKind;
  excerpt?: string;
}

/** Writes notifications about one todo, skipping the caller's own browser actions and doubles. */
function send(
  sc: Scoped,
  acting: Acting,
  todoId: number,
  actor: string,
  at: string,
  list: readonly NewNotification[],
): void {
  const self = acting.callerVia === "session" ? acting.callerId : undefined;
  const seen = new Set<number>();
  const rows = list.filter((n) => {
    if (n.recipientId === self || seen.has(n.recipientId)) return false;
    seen.add(n.recipientId);
    return true;
  });
  if (rows.length === 0) return;
  sc.db
    .insert(notifications)
    .values(
      rows.map((n) => ({
        recipientId: n.recipientId,
        todoAccountId: sc.accountId,
        todoId,
        kind: n.kind,
        actor,
        excerpt: (n.excerpt ?? "").slice(0, EXCERPT),
        createdAt: at,
      })),
    )
    .run();
  for (const row of rows) prune(sc.db, row.recipientId);
}

/** Keeps the newest MAX_NOTIFICATIONS of a user. */
function prune(tx: Tx, recipientId: number): void {
  tx.run(sql`DELETE FROM ${notifications} WHERE ${notifications.recipientId} = ${recipientId}
    AND ${notifications.id} NOT IN (SELECT ${notifications.id} FROM ${notifications}
      WHERE ${notifications.recipientId} = ${recipientId} ORDER BY ${notifications.id} DESC LIMIT ${MAX_NOTIFICATIONS})`);
}

/** Who hears about a todo: its assignee in a shared project, else (unassigned) everyone; an own todo's owner. */
function watchers(sc: Scoped, assigneeId: number | null, everyoneWhenUnassigned: boolean): number[] {
  const members = membersOf(sc.db, sc.accountId);
  if (members === null) return [sc.accountId];
  if (assigneeId !== null) return [assigneeId];
  return everyoneWhenUnassigned ? members.map((m) => m.id) : [];
}

/**
 * Notifications for a todo change: the new assignee, and who hears about a todo when it is marked action
 * needed (or its reason changes). `before` is null for a new todo.
 */
export function notifyTodoChange(
  sc: Scoped,
  acting: Acting,
  actor: string,
  at: string,
  before: Pick<Todo, "assignee" | "actionNeeded"> | null,
  after: Todo,
): void {
  const list: NewNotification[] = [];
  const reason = after.actionNeeded?.reason;
  if (reason !== undefined && reason !== (before?.actionNeeded?.reason ?? null))
    for (const id of watchers(sc, after.assignee?.accountId ?? null, true))
      list.push({ recipientId: id, kind: "action_needed", excerpt: reason });
  const assignee = after.assignee?.accountId;
  if (assignee !== undefined && assignee !== before?.assignee?.accountId)
    list.push({ recipientId: assignee, kind: "assigned" });
  // One notification per person and change: assigned and marked at once says action needed.
  send(sc, acting, after.id, actor, at, list);
}

/** Notifications for a new comment: members it mentions (@username), then who hears about the todo. */
export function notifyComment(
  sc: Scoped,
  acting: Acting,
  actor: string,
  at: string,
  todo: { id: number; assigneeId: number | null },
  bodyMd: string,
): void {
  const excerpt = plainText(bodyMd);
  const members = membersOf(sc.db, sc.accountId) ?? [];
  const named = new Set(mentionedUsernames(bodyMd));
  const list: NewNotification[] = members
    .filter((m) => named.has(m.username.toLowerCase()))
    .map((m) => ({ recipientId: m.id, kind: "mentioned" as const, excerpt }));
  for (const id of watchers(sc, todo.assigneeId, false))
    list.push({ recipientId: id, kind: "commented", excerpt });
  send(sc, acting, todo.id, actor, at, list);
}

// ---------- reading ----------

/** The accounts a user may see todos of: their own and the shared projects they are in now. */
function reachable(tx: Tx, user: { id: number; role: string }): Set<number> {
  const out = new Set([user.id]);
  for (const row of tx
    .select({ id: spaceMembers.spaceId })
    .from(spaceMembers)
    .where(eq(spaceMembers.accountId, user.id))
    .all())
    out.add(row.id);
  if (user.role === "admin") {
    const feedback = tx.select().from(spaces).where(eq(spaces.systemKey, FEEDBACK_KEY)).get();
    if (feedback) out.add(feedback.accountId);
  }
  return out;
}

function userOf(tx: Tx, id: number): { id: number; role: string } {
  return (
    tx.select({ id: accounts.id, role: accounts.role }).from(accounts).where(eq(accounts.id, id)).get() ?? {
      id,
      role: "user",
    }
  );
}

/**
 * The user's notifications, newest first, with the unread count. Notifications about shared projects the
 * user has left are left out (and dropped).
 */
export function listNotifications(
  ctx: Pick<Ctx, "db">,
  userId: number,
  query: NotificationQuery,
): NotificationList {
  const user = userOf(ctx.db, userId);
  const allowed = [...reachable(ctx.db, user)];
  // Left a shared project: what was said there is no longer the user's to read.
  ctx.db
    .delete(notifications)
    .where(and(eq(notifications.recipientId, userId), notInArray(notifications.todoAccountId, allowed)))
    .run();
  const mine = eq(notifications.recipientId, userId);
  const rows = ctx.db
    .select({
      n: notifications,
      title: todos.title,
      status: todos.status,
      spaceName: accounts.displayName,
    })
    .from(notifications)
    .innerJoin(
      todos,
      and(eq(todos.accountId, notifications.todoAccountId), eq(todos.id, notifications.todoId)),
    )
    .innerJoin(accounts, eq(accounts.id, notifications.todoAccountId))
    .where(query.unread === true ? and(mine, isNull(notifications.readAt)) : mine)
    .orderBy(desc(notifications.id))
    .limit(query.limit)
    .all();
  const { n: unreadCount } = ctx.db.get<{ n: number }>(
    sql`SELECT count(*) AS n FROM ${notifications} WHERE ${notifications.recipientId} = ${userId} AND ${notifications.readAt} IS NULL`,
  );
  const items: Notification[] = rows.map(({ n, title, status, spaceName }) => {
    const shared = n.todoAccountId !== userId;
    return {
      id: n.id,
      kind: n.kind,
      actor: n.actor,
      excerpt: n.excerpt,
      todo: { id: n.todoId, title, status, ref: shared ? `S${n.todoAccountId}#${n.todoId}` : `#${n.todoId}` },
      space: shared ? { id: n.todoAccountId, name: spaceName } : null,
      createdAt: n.createdAt,
      readAt: n.readAt,
    };
  });
  return { items, unreadCount };
}

/** Marks the user's notifications read (or unread again); ids of others are ignored. */
export function markNotifications(
  ctx: Pick<Ctx, "db" | "clock">,
  userId: number,
  input: MarkNotifications,
): void {
  const readAt = input.read ? ctx.clock().toISOString() : null;
  const mine = eq(notifications.recipientId, userId);
  if (input.all) {
    ctx.db
      .update(notifications)
      .set({ readAt })
      .where(input.read ? and(mine, isNull(notifications.readAt)) : mine)
      .run();
    return;
  }
  for (const part of chunks(input.ids ?? [])) {
    ctx.db
      .update(notifications)
      .set({ readAt })
      .where(and(mine, inArray(notifications.id, part)))
      .run();
  }
}
