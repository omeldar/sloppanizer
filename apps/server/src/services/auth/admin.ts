import type { AccountStatus, AdminAccount, AdminSignup } from "@organizer/shared";
import { and, asc, count, eq, sum } from "drizzle-orm";
import { accounts, passkeys } from "../../db/auth-schema.ts";
import type { Db } from "../../db/index.ts";
import { attachments } from "../../db/schema.ts";
import { ApiError } from "../../http/errors.ts";
import { type AccountRow, deleteAccount, getAccount } from "../accounts.ts";
import type { Tx } from "../context.ts";
import { seedAccount } from "../owned.ts";
import { newOneTimeCode } from "./crypto.ts";
import { SIGNUP_EXPIRY_MS, startLoginReset } from "./flows.ts";
import type { AuthServices } from "./index.ts";
import { logAdminEvent } from "./instance.ts";
import { countLiveSessions, revokeAccountSessions } from "./sessions.ts";
import { clearFailures, lockedUntil, nameKey } from "./throttle.ts";

/**
 * What an admin (or the admin CLI) can do to accounts. Only metadata ever leaves here: no titles, no
 * names of people, no counts of an account's todos. Every change is written to the admin log.
 */

const iso = (ms: number): string => new Date(ms).toISOString();

/** Every admin lookup of an account by id: unknown ids are 404 like any missing record. */
function accountById(tx: Tx, id: number): AccountRow {
  const row = getAccount(tx, id);
  if (!row) throw new ApiError("not_found", `Account ${id} does not exist. Check the id.`);
  return row;
}

const SELF = "Use your own security page.";

/** Admin actions on the admin's own account are refused (they go through the security page). */
function notSelf(row: AccountRow, actorId: number | null): void {
  if (actorId !== null && row.id === actorId) throw new ApiError("conflict", SELF);
}

export function filesBytesOf(tx: Tx, accountId: number): number {
  const row = tx
    .select({ bytes: sum(attachments.size) })
    .from(attachments)
    .where(eq(attachments.accountId, accountId))
    .get();
  return Number(row?.bytes ?? 0);
}

export function toAdminAccount(tx: Tx, nowMs: number, row: AccountRow): AdminAccount {
  const passkeyCount =
    tx.select({ n: count() }).from(passkeys).where(eq(passkeys.accountId, row.id)).get()?.n ?? 0;
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
    createdAt: row.createdAt,
    approvedAt: row.approvedAt,
    lastLoginAt: row.lastLoginAt,
    lockedUntil: lockedUntil(tx, nameKey(row.username), nowMs),
    activeSessions: countLiveSessions(tx, row.id, nowMs),
    methods: {
      password: row.passwordHash !== null,
      totp: row.totpSecretEnc !== null,
      passkeys: passkeyCount,
    },
    filesBytes: filesBytesOf(tx, row.id),
    resetPending: row.resetExpiresAt !== null && Date.parse(row.resetExpiresAt) > nowMs,
  };
}

export function listSignups(tx: Tx): AdminSignup[] {
  return tx
    .select()
    .from(accounts)
    .where(eq(accounts.status, "pending"))
    .orderBy(asc(accounts.createdAt), asc(accounts.id))
    .all()
    .map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      note: row.signupNote,
      createdAt: row.createdAt,
      expiresAt: iso(Date.parse(row.createdAt) + SIGNUP_EXPIRY_MS),
    }));
}

export function listAccounts(tx: Tx, nowMs: number, status?: AccountStatus): AdminAccount[] {
  return tx
    .select()
    .from(accounts)
    .where(status ? eq(accounts.status, status) : undefined)
    .orderBy(asc(accounts.username))
    .all()
    .map((row) => toAdminAccount(tx, nowMs, row));
}

function pendingById(tx: Tx, id: number): AccountRow {
  const row = getAccount(tx, id);
  if (row?.status !== "pending")
    throw new ApiError("not_found", `Sign-up ${id} does not exist. Check the id.`);
  return row;
}

export interface Actor {
  /** Admin username, or "cli". */
  name: string;
  /** The admin's account id (null for the CLI). */
  accountId: number | null;
}

export function approveSignup(db: Db, nowMs: number, actor: Actor, id: number): AdminAccount {
  return db.transaction((tx) => {
    const row = pendingById(tx, id);
    const nowIso = iso(nowMs);
    tx.update(accounts)
      .set({ status: "active", approvedAt: nowIso, approvedBy: actor.accountId, updatedAt: nowIso })
      .where(eq(accounts.id, row.id))
      .run();
    seedAccount(tx, row.id, nowIso);
    logAdminEvent(tx, nowIso, actor.name, "approve", row.username);
    return toAdminAccount(tx, nowMs, accountById(tx, row.id));
  });
}

/** Rejected sign-ups are deleted at once (with their factors); the log keeps the username. */
export function rejectSignup(db: Db, nowMs: number, actor: Actor, id: number): void {
  db.transaction((tx) => {
    const row = pendingById(tx, id);
    tx.delete(accounts).where(eq(accounts.id, row.id)).run();
    logAdminEvent(tx, iso(nowMs), actor.name, "reject", row.username);
  });
}

export function disableAccount(db: Db, nowMs: number, actor: Actor, id: number): AdminAccount {
  return db.transaction((tx) => {
    const row = accountById(tx, id);
    notSelf(row, actor.accountId);
    if (row.status === "pending") throw new ApiError("conflict", "Approve or reject a sign-up instead.");
    const nowIso = iso(nowMs);
    if (row.status === "active") {
      tx.update(accounts)
        .set({ status: "disabled", disabledAt: nowIso, updatedAt: nowIso })
        .where(eq(accounts.id, row.id))
        .run();
      revokeAccountSessions(tx, nowMs, row.id, "disabled");
      logAdminEvent(tx, nowIso, actor.name, "disable", row.username);
    }
    return toAdminAccount(tx, nowMs, accountById(tx, row.id));
  });
}

export function enableAccount(db: Db, nowMs: number, actor: Actor, id: number): AdminAccount {
  return db.transaction((tx) => {
    const row = accountById(tx, id);
    notSelf(row, actor.accountId);
    if (row.status === "pending") throw new ApiError("conflict", "Approve or reject a sign-up instead.");
    const nowIso = iso(nowMs);
    if (row.status === "disabled") {
      tx.update(accounts)
        .set({ status: "active", disabledAt: null, updatedAt: nowIso })
        .where(eq(accounts.id, row.id))
        .run();
      logAdminEvent(tx, nowIso, actor.name, "enable", row.username);
    }
    return toAdminAccount(tx, nowMs, accountById(tx, row.id));
  });
}

export function unlockAccount(db: Db, nowMs: number, actor: Actor, id: number): AdminAccount {
  return db.transaction((tx) => {
    const row = accountById(tx, id);
    notSelf(row, actor.accountId);
    clearFailures(tx, nameKey(row.username));
    logAdminEvent(tx, iso(nowMs), actor.name, "unlock", row.username);
    return toAdminAccount(tx, nowMs, row);
  });
}

/** Returns the reset code once (only its hash is stored) and until when it works. */
export function resetAccountLogin(
  db: Db,
  nowMs: number,
  actor: Actor,
  id: number,
): { resetCode: string; expiresAt: string } {
  return db.transaction((tx) => {
    const row = accountById(tx, id);
    notSelf(row, actor.accountId);
    if (row.status === "pending") throw new ApiError("conflict", "Approve or reject a sign-up instead.");
    const resetCode = newOneTimeCode();
    const expiresAt = startLoginReset(tx, nowMs, row, resetCode);
    logAdminEvent(tx, iso(nowMs), actor.name, "reset_login", row.username);
    return { resetCode, expiresAt };
  });
}

/** Emergency (CLI only): makes an account admin, e.g. when the only admin is locked out. */
export function makeAdmin(db: Db, nowMs: number, actor: Actor, username: string): AccountRow {
  return db.transaction((tx) => {
    const row = tx.select().from(accounts).where(eq(accounts.username, username)).get();
    if (!row) throw new ApiError("not_found", `Account ${username} does not exist.`);
    if (row.status !== "active") throw new ApiError("conflict", `Account ${username} is not active.`);
    tx.update(accounts)
      .set({ role: "admin", updatedAt: iso(nowMs) })
      .where(eq(accounts.id, row.id))
      .run();
    logAdminEvent(tx, iso(nowMs), actor.name, "make_admin", row.username);
    return accountById(tx, row.id);
  });
}

/** Deletes a disabled account with all its data and files; the confirm must be its username. */
export function adminDeleteAccount(
  db: Db,
  auth: AuthServices,
  nowMs: number,
  actor: Actor,
  id: number,
  confirmUsername: string,
): void {
  const row = accountById(db, id);
  notSelf(row, actor.accountId);
  if (row.status !== "disabled") throw new ApiError("conflict", "Disable the account before you delete it.");
  if (confirmUsername !== row.username) {
    throw new ApiError("validation_failed", "Type the account's username to confirm the delete.");
  }
  deleteAccount(db, auth.config, row, (tx) =>
    logAdminEvent(tx, iso(nowMs), actor.name, "delete", row.username),
  );
}

/** Hourly: pending sign-ups older than 30 days are deleted (logged as expire_signup). */
export function expireSignups(db: Db, nowMs: number): number {
  const cutoff = iso(nowMs - SIGNUP_EXPIRY_MS);
  return db.transaction((tx) => {
    const old = tx
      .select()
      .from(accounts)
      .where(eq(accounts.status, "pending"))
      .all()
      .filter((row) => row.createdAt <= cutoff);
    for (const row of old) {
      tx.delete(accounts)
        .where(and(eq(accounts.id, row.id), eq(accounts.status, "pending")))
        .run();
      logAdminEvent(tx, iso(nowMs), "system", "expire_signup", row.username);
    }
    return old.length;
  });
}
