import { randomBytes } from "node:crypto";
import {
  type AddSpaceMember,
  type CreateFeedback,
  type CreateSpace,
  FEEDBACK_LABELS,
  PROJECT_COLORS,
  personLabel,
  type Space,
  type SpaceMember,
  type SpaceRole,
  type UpdateSpace,
  type UserBrief,
} from "@organizer/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Config } from "../config.ts";
import { accounts, spaceMembers, spaces } from "../db/auth-schema.ts";
import type { Db } from "../db/index.ts";
import { labels } from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import { type AccountRow, deleteAccount, getAccount, newWebauthnUserId } from "./accounts.ts";
import type { Ctx, Tx } from "./context.ts";
import { createLabel } from "./labels.ts";
import { owned, seedAccount } from "./owned.ts";
import { createProject, listProjects, updateProject } from "./projects.ts";
import { foldCase } from "./text.ts";
import { createTodo } from "./todos.ts";
import { unassignMember } from "./assignees.ts";

/**
 * Shared projects. A shared project is a space: a hidden account (kind "space", username "~..." that no
 * sign-in form accepts) holding one project and everything in it. Members act in it by sending the
 * X-Sloppanizer-Space header from their own browser session; the security hook checks membership and
 * scopes the request to the space (http/security.ts), so every todo feature works there unchanged.
 * Changes show the member's name ("First Last" or the username) in the history.
 *
 * The Sloppanizer project (system key "feedback") is made on first use. Its members are all active admins
 * (decided at each request, never stored); every user can send it a bug report or feature request.
 */

export const FEEDBACK_KEY = "feedback";
const FEEDBACK_NAME = "Sloppanizer";

type SpaceRow = typeof spaces.$inferSelect;

/** The label a person goes by in shared projects: "First Last" when set, else the username. */
export const memberName = (row: Pick<AccountRow, "firstName" | "lastName" | "username">): string =>
  personLabel(row);

/** Creates the hidden account of a space and its row. Returns the space account. */
function insertSpace(
  tx: Tx,
  nowIso: string,
  input: { name: string; color: string; timeZone: string; systemKey?: string; createdBy?: number },
): AccountRow {
  const row = tx
    .insert(accounts)
    .values({
      username: `~space-${randomBytes(6).toString("hex")}`,
      displayName: input.name,
      kind: "space",
      color: input.color,
      timeZone: input.timeZone,
      role: "user",
      status: "active",
      passwordHash: null,
      webauthnUserId: newWebauthnUserId(),
      createdAt: nowIso,
      updatedAt: nowIso,
      approvedAt: nowIso,
    })
    .returning()
    .get();
  tx.insert(spaces)
    .values({
      accountId: row.id,
      systemKey: input.systemKey ?? null,
      createdBy: input.createdBy ?? null,
      createdAt: nowIso,
    })
    .run();
  seedAccount(tx, row.id, nowIso);
  return row;
}

const spaceCtx = (db: Db, clock: () => Date, row: AccountRow, timeZone?: string): Ctx => ({
  db,
  clock,
  timeZone: timeZone ?? row.timeZone,
  accountId: row.id,
});

/** Makes the space's project (named like the space) and, for feedback, the bug and feature labels. */
function seedSpaceContent(ctx: Ctx, name: string, color: string, feedback: boolean): void {
  createProject(ctx, {
    name,
    color,
    ...(feedback ? { slug: "sloppanizer", description: "Bug reports and feature requests from users." } : {}),
  });
  if (!feedback) return;
  for (const label of Object.values(FEEDBACK_LABELS)) {
    const exists = ctx.db
      .select({ id: labels.id })
      .from(labels)
      .where(owned(ctx, labels, eq(labels.nameKey, foldCase(label.name))))
      .get();
    if (!exists) createLabel(ctx, { name: label.name, color: label.color });
  }
}

/** Makes the Sloppanizer project if it does not exist yet (and its labels). Returns its space id. */
export function ensureFeedbackSpace(db: Db, clock: () => Date, timeZone: string): number {
  const existing = db.select().from(spaces).where(eq(spaces.systemKey, FEEDBACK_KEY)).get();
  if (existing) {
    // Labels deleted by hand come back, so feedback always finds them.
    const row = getAccount(db, existing.accountId) as AccountRow;
    const ctx = spaceCtx(db, clock, row);
    for (const label of Object.values(FEEDBACK_LABELS)) {
      const found = db
        .select({ id: labels.id })
        .from(labels)
        .where(owned(ctx, labels, eq(labels.nameKey, foldCase(label.name))))
        .get();
      if (!found) createLabel(ctx, { name: label.name, color: label.color });
    }
    return existing.accountId;
  }
  const nowIso = clock().toISOString();
  const row = db.transaction((tx) =>
    insertSpace(tx, nowIso, {
      name: FEEDBACK_NAME,
      color: PROJECT_COLORS[1],
      timeZone,
      systemKey: FEEDBACK_KEY,
    }),
  );
  seedSpaceContent(spaceCtx(db, clock, row), FEEDBACK_NAME, PROJECT_COLORS[1], true);
  return row.id;
}

/** Your role in a space, or null when you may not open it. Admins own the Sloppanizer project. */
export function roleIn(tx: Tx, member: Pick<AccountRow, "id" | "role">, spaceId: number): SpaceRole | null {
  const space = tx.select().from(spaces).where(eq(spaces.accountId, spaceId)).get();
  if (!space) return null;
  if (space.systemKey === FEEDBACK_KEY) return member.role === "admin" ? "owner" : null;
  const row = tx
    .select({ role: spaceMembers.role })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.accountId, member.id)))
    .get();
  return row?.role ?? null;
}

/** The space account of a request, when the caller may act in it. */
export function openSpace(
  tx: Tx,
  member: Pick<AccountRow, "id" | "role">,
  spaceId: number,
): { space: AccountRow; role: SpaceRole } | null {
  const role = roleIn(tx, member, spaceId);
  if (!role) return null;
  const space = getAccount(tx, spaceId);
  if (!space || space.kind !== "space" || space.status !== "active") return null;
  return { space, role };
}

function membersOf(tx: Tx, space: SpaceRow): SpaceMember[] {
  if (space.systemKey === FEEDBACK_KEY) {
    return tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.role, "admin"), eq(accounts.status, "active"), eq(accounts.kind, "user")))
      .orderBy(asc(accounts.username))
      .all()
      .map((row) => ({
        accountId: row.id,
        username: row.username,
        name: memberName(row),
        role: "owner",
        addedAt: null,
      }));
  }
  return tx
    .select({ account: accounts, role: spaceMembers.role, addedAt: spaceMembers.addedAt })
    .from(spaceMembers)
    .innerJoin(accounts, eq(accounts.id, spaceMembers.accountId))
    .where(eq(spaceMembers.spaceId, space.accountId))
    .orderBy(sql`${spaceMembers.role} <> 'owner'`, asc(accounts.username))
    .all()
    .map(({ account, role, addedAt }) => ({
      accountId: account.id,
      username: account.username,
      name: memberName(account),
      role,
      addedAt,
    }));
}

function toSpace(db: Db, clock: () => Date, space: SpaceRow, role: SpaceRole): Space {
  const row = getAccount(db, space.accountId) as AccountRow;
  const project = listProjects(spaceCtx(db, clock, row)).find((p) => p.archivedAt === null);
  return {
    id: space.accountId,
    name: row.displayName,
    color: row.color,
    system: space.systemKey === FEEDBACK_KEY ? "feedback" : null,
    projectSlug: project?.slug ?? null,
    openCount: project?.openCount ?? 0,
    role,
    members: membersOf(db, space),
    createdAt: space.createdAt,
  };
}

/** The shared projects you can open: the Sloppanizer project first (admins), then by name. */
export function listSpaces(db: Db, clock: () => Date, member: AccountRow): Space[] {
  // Made the first time an admin looks (or a user sends feedback), not on a fresh instance.
  if (member.role === "admin") ensureFeedbackSpace(db, clock, member.timeZone);
  const memberOf = new Set(
    db
      .select({ spaceId: spaceMembers.spaceId })
      .from(spaceMembers)
      .where(eq(spaceMembers.accountId, member.id))
      .all()
      .map((r) => r.spaceId),
  );
  const rows = db.select().from(spaces).all();
  return rows
    .flatMap((space) => {
      const role = space.systemKey === FEEDBACK_KEY ? roleIn(db, member, space.accountId) : null;
      if (space.systemKey === FEEDBACK_KEY) return role ? [toSpace(db, clock, space, role)] : [];
      if (!memberOf.has(space.accountId)) return [];
      return [toSpace(db, clock, space, roleIn(db, member, space.accountId) as SpaceRole)];
    })
    .toSorted((a, b) =>
      a.system !== b.system
        ? a.system
          ? -1
          : 1
        : a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
}

function spaceFor(db: Db, member: AccountRow, id: number): { space: SpaceRow; role: SpaceRole } {
  const space = db.select().from(spaces).where(eq(spaces.accountId, id)).get();
  const role = space ? roleIn(db, member, id) : null;
  if (!space || !role) throw new ApiError("not_found", `Shared project ${id} does not exist. Check the id.`);
  return { space, role };
}

function ownerOf(db: Db, member: AccountRow, id: number): SpaceRow {
  const { space, role } = spaceFor(db, member, id);
  if (role !== "owner") throw new ApiError("forbidden", "Only the owners of a shared project can change it.");
  return space;
}

const notSystem = (space: SpaceRow, what: string): void => {
  if (space.systemKey !== null) {
    throw new ApiError("conflict", `The Sloppanizer project belongs to every admin: you cannot ${what} it.`);
  }
};

/** An active user account by username, for adding as a member (404 otherwise). */
function userByName(tx: Tx, username: string): AccountRow {
  const row = tx.select().from(accounts).where(eq(accounts.username, username)).get();
  if (!row || row.kind !== "user" || row.status !== "active") {
    throw new ApiError("not_found", `No active account is called "${username}". Check the username.`);
  }
  return row;
}

export function getSpace(db: Db, clock: () => Date, member: AccountRow, id: number): Space {
  const { space, role } = spaceFor(db, member, id);
  return toSpace(db, clock, space, role);
}

export function createSpace(db: Db, clock: () => Date, owner: AccountRow, input: CreateSpace): Space {
  const nowIso = clock().toISOString();
  const color = input.color ?? PROJECT_COLORS[2];
  const row = db.transaction((tx) => {
    const others = (input.members ?? []).filter((u) => u !== owner.username).map((u) => userByName(tx, u));
    const space = insertSpace(tx, nowIso, {
      name: input.name,
      color,
      timeZone: owner.timeZone,
      createdBy: owner.id,
    });
    const seen = new Set<number>([owner.id]);
    tx.insert(spaceMembers)
      .values({ spaceId: space.id, accountId: owner.id, role: "owner", addedAt: nowIso })
      .run();
    for (const other of others) {
      if (seen.has(other.id)) continue;
      seen.add(other.id);
      tx.insert(spaceMembers)
        .values({ spaceId: space.id, accountId: other.id, role: "member", addedAt: nowIso })
        .run();
    }
    return space;
  });
  seedSpaceContent(spaceCtx(db, clock, row), input.name, color, false);
  return getSpace(db, clock, owner, row.id);
}

/** Renames or recolors the space and its project. */
export function updateSpace(
  db: Db,
  clock: () => Date,
  member: AccountRow,
  id: number,
  input: UpdateSpace,
): Space {
  const space = ownerOf(db, member, id);
  if (input.name !== undefined) notSystem(space, "rename");
  const nowIso = clock().toISOString();
  db.update(accounts)
    .set({
      ...(input.name !== undefined ? { displayName: input.name } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      updatedAt: nowIso,
    })
    .where(eq(accounts.id, id))
    .run();
  const row = getAccount(db, id) as AccountRow;
  const ctx = spaceCtx(db, clock, row);
  const project = listProjects(ctx).find((p) => p.archivedAt === null);
  if (project) {
    updateProject(ctx, project.id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
    });
  }
  return getSpace(db, clock, member, id);
}

export function addSpaceMember(
  db: Db,
  clock: () => Date,
  member: AccountRow,
  id: number,
  input: AddSpaceMember,
): Space {
  const space = ownerOf(db, member, id);
  notSystem(space, "add members to");
  const other = userByName(db, input.username);
  db.insert(spaceMembers)
    .values({ spaceId: id, accountId: other.id, role: "member", addedAt: clock().toISOString() })
    .onConflictDoNothing()
    .run();
  return getSpace(db, clock, member, id);
}

/**
 * Removes a member (owners remove anyone, everyone can remove themselves = leave). The last owner cannot
 * leave while others remain; a space left without members is deleted.
 */
export function removeSpaceMember(
  db: Db,
  config: Config,
  clock: () => Date,
  member: AccountRow,
  id: number,
  accountId: number,
): void {
  const { space, role } = spaceFor(db, member, id);
  notSystem(space, "leave or remove members from");
  if (accountId !== member.id && role !== "owner") {
    throw new ApiError("forbidden", "Only the owners of a shared project can remove other members.");
  }
  const rows = db.select().from(spaceMembers).where(eq(spaceMembers.spaceId, id)).all();
  const target = rows.find((r) => r.accountId === accountId);
  if (!target) throw new ApiError("not_found", `Account ${accountId} is not a member. Check the id.`);
  const owners = rows.filter((r) => r.role === "owner");
  if (target.role === "owner" && owners.length === 1 && rows.length > 1) {
    throw new ApiError(
      "conflict",
      "You are the only owner. Delete the shared project, or remove the other members first.",
    );
  }
  if (rows.length === 1) {
    deleteSpace(db, config, member, id);
    return;
  }
  db.transaction((tx) => {
    tx.delete(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, id), eq(spaceMembers.accountId, accountId)))
      .run();
    // Their todos in the project are nobody's now (a line in each history says so).
    unassignMember(tx, id, accountId, memberName(member), clock().toISOString());
  });
}

/** Deletes the space with all its todos, notes and files. */
export function deleteSpace(db: Db, config: Config, member: AccountRow, id: number): void {
  const space = ownerOf(db, member, id);
  notSystem(space, "delete");
  deleteAccount(db, config, getAccount(db, id) as AccountRow);
}

/** Spaces whose members all left through an account delete (cascade): deleted with their data. */
export function deleteOrphanSpaces(db: Db, config: Config): number {
  const orphans = db
    .select({ id: spaces.accountId })
    .from(spaces)
    .where(
      and(
        sql`${spaces.systemKey} IS NULL`,
        sql`NOT EXISTS (SELECT 1 FROM space_members m WHERE m.space_id = ${spaces.accountId})`,
      ),
    )
    .all();
  const rows = orphans.length
    ? db
        .select()
        .from(accounts)
        .where(
          inArray(
            accounts.id,
            orphans.map((o) => o.id),
          ),
        )
        .all()
    : [];
  for (const row of rows) deleteAccount(db, config, row);
  return rows.length;
}

/**
 * A bug report or feature request from any user: a todo in the Sloppanizer project with the kind's label
 * and the sender as its requester (a person named "First Last", or the username).
 */
export function submitFeedback(
  db: Db,
  clock: () => Date,
  sender: AccountRow,
  input: CreateFeedback,
  appVersion: string,
): { id: number } {
  const spaceId = ensureFeedbackSpace(db, clock, sender.timeZone);
  const space = getAccount(db, spaceId) as AccountRow;
  const ctx = spaceCtx(db, clock, space, sender.timeZone);
  const name = memberName(sender);
  const project =
    listProjects(ctx).find((p) => p.slug === "sloppanizer" && p.archivedAt === null) ??
    listProjects(ctx).find((p) => p.archivedAt === null);
  const details = [
    input.description?.trim() ?? "",
    "",
    "---",
    `Sent by ${name} (@${sender.username})${input.page ? ` from \`${input.page.replace(/`/g, "")}\`` : ""}, Sloppanizer ${appVersion}.`,
  ]
    .join("\n")
    .trim();
  const todo = createTodo(ctx, name, {
    title: input.title,
    descriptionMd: details,
    projectId: project?.id ?? null,
    labels: [FEEDBACK_LABELS[input.kind].name],
    // The sender as a linked person ("First Last", or the username).
    requestedBy: [{ username: sender.username }],
  });
  return { id: todo.id };
}

/** Users matching the search (username or name), to add as a person; never the caller or a space. */
export function searchUsers(db: Db, callerId: number, q: string, limit: number): UserBrief[] {
  const needle = foldCase(q.trim());
  return db
    .select()
    .from(accounts)
    .where(and(eq(accounts.kind, "user"), eq(accounts.status, "active")))
    .orderBy(asc(accounts.username))
    .all()
    .filter((row) => row.id !== callerId)
    .filter(
      (row) =>
        needle === "" ||
        [row.username, row.firstName, row.lastName, row.displayName, memberName(row)].some((text) =>
          foldCase(text).includes(needle),
        ),
    )
    .slice(0, limit)
    .map((row) => ({
      username: row.username,
      name: memberName(row),
      firstName: row.firstName,
      lastName: row.lastName,
    }));
}
