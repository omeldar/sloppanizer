import { personLabel, type TodoAssignee } from "@organizer/shared";
import { and, eq, inArray } from "drizzle-orm";
import { accounts, spaceMembers, spaces } from "../db/auth-schema.ts";
import { todos } from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import type { Scoped, Tx } from "./context.ts";
import { recordEvents } from "./events.ts";
import { owned } from "./owned.ts";
import { chunks } from "./sql.ts";

/**
 * Assignees of todos in shared projects. A todo can be assigned to one member of the shared project it
 * lives in (its account is the space). Membership is checked when it is set; a member who leaves or is
 * removed is taken off every todo of that project (removeSpaceMember), and a deleted account clears
 * itself (ON DELETE SET NULL). Todos never move between accounts, so a todo cannot leave its shared
 * project with an assignee. In the Sloppanizer project the members are its admins.
 */

/** Kept in step with services/spaces.ts (FEEDBACK_KEY); not imported to keep the import graph flat. */
const FEEDBACK_KEY = "feedback";

/** The space row of the scope's account, or undefined when it is a personal account. */
const spaceOf = (tx: Tx, accountId: number) =>
  tx.select().from(spaces).where(eq(spaces.accountId, accountId)).get();

/** Whether the user account may be assigned in the space: a member (or an active admin for feedback). */
export function isAssignable(tx: Tx, spaceId: number, userId: number): boolean {
  const space = spaceOf(tx, spaceId);
  if (!space) return false;
  const user = tx.select().from(accounts).where(eq(accounts.id, userId)).get();
  if (!user || user.kind !== "user" || user.status !== "active") return false;
  if (space.systemKey === FEEDBACK_KEY) return user.role === "admin";
  if (space.systemKey !== null) return false;
  const row = tx
    .select({ accountId: spaceMembers.accountId })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.accountId, userId)))
    .get();
  return row !== undefined;
}

/**
 * The account id for an assignee given by username (null clears it). 422 outside shared projects and
 * for anyone who is not a member of this one (the same answer for unknown usernames, so it tells
 * nothing about accounts outside the project).
 */
export function resolveAssignee(sc: Scoped, username: string | null): number | null {
  if (username === null) return null;
  if (!spaceOf(sc.db, sc.accountId)) {
    throw new ApiError(
      "validation_failed",
      "Only todos in a shared project can be assigned. Your own todos are always yours.",
    );
  }
  const user = sc.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.username, username.trim().toLowerCase()))
    .get();
  if (!user || !isAssignable(sc.db, sc.accountId, user.id)) {
    throw new ApiError(
      "validation_failed",
      `"${username}" is not a member of this shared project. Assign one of its members.`,
    );
  }
  return user.id;
}

/** The assignee of a todo as the API shows it. */
export function assigneesById(tx: Tx, ids: readonly (number | null)[]): Map<number, TodoAssignee> {
  const wanted = [...new Set(ids.filter((id): id is number => id !== null))];
  const byId = new Map<number, TodoAssignee>();
  for (const part of chunks(wanted)) {
    for (const row of tx.select().from(accounts).where(inArray(accounts.id, part)).all()) {
      byId.set(row.id, { accountId: row.id, username: row.username, name: personLabel(row) });
    }
  }
  return byId;
}

/** What the history stores about an assignee: id and name at the time. */
export const assigneeSummary = (a: TodoAssignee | null): { accountId: number; name: string } | null =>
  a === null ? null : { accountId: a.accountId, name: a.name };

/**
 * Takes a member off every todo of the shared project (they left or were removed), with an
 * assignee_changed line in each todo's history by `actor`.
 */
export function unassignMember(tx: Tx, spaceId: number, userId: number, actor: string, at: string): number {
  const sc: Scoped = { db: tx, accountId: spaceId };
  const rows = tx
    .select({ id: todos.id })
    .from(todos)
    .where(owned(sc, todos, eq(todos.assigneeId, userId)))
    .all();
  if (rows.length === 0) return 0;
  const from = assigneeSummary(assigneesById(tx, [userId]).get(userId) ?? null);
  tx.update(todos)
    .set({ assigneeId: null, updatedAt: at, lastActivityAt: at })
    .where(owned(sc, todos, eq(todos.assigneeId, userId)))
    .run();
  recordEvents(
    sc,
    actor,
    at,
    rows.map((r) => ({ todoId: r.id, kind: "assignee_changed" as const, data: { from, to: null } })),
  );
  return rows.length;
}
