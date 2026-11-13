import { randomBytes } from "node:crypto";
import {
  type AccountBrief,
  type AccountProfile,
  type AccountRole,
  type AccountStatus,
  PROJECT_COLORS,
  RECOVERY_CODE_COUNT,
  type UpdateAccount,
} from "@organizer/shared";
import { and, count, eq, isNull, ne } from "drizzle-orm";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { accounts, passkeys, recoveryCodes } from "../db/auth-schema.ts";
import type { Db } from "../db/index.ts";
import { ApiError } from "../http/errors.ts";
import type { AuthAccount, Tx } from "./context.ts";
import { encryptSecret, newRecoveryCode, sha256Hex } from "./auth/crypto.ts";
import { cleanStaged } from "./restore.ts";
import { removeAccountFromIndex } from "./search-index.ts";

/** Account rows: creating them, reading them as API shapes, and their sign-in factors. */

export type AccountRow = typeof accounts.$inferSelect;

/** Purpose bound into the encrypted authenticator secret (AES-GCM additional data). */
export const TOTP_PURPOSE = "totp";

export const toBrief = (row: AccountRow): AccountBrief => ({
  id: row.id,
  username: row.username,
  displayName: row.displayName,
  color: (PROJECT_COLORS as readonly string[]).includes(row.color)
    ? (row.color as AccountBrief["color"])
    : PROJECT_COLORS[0],
  role: row.role,
});

export const toAuthAccount = (row: AccountRow): AuthAccount => ({ ...toBrief(row), timeZone: row.timeZone });

export const getAccount = (tx: Tx, id: number): AccountRow | undefined =>
  tx.select().from(accounts).where(eq(accounts.id, id)).get();

export const findAccount = (tx: Tx, username: string): AccountRow | undefined =>
  tx.select().from(accounts).where(eq(accounts.username, username)).get();

export interface NewAccount {
  username: string;
  displayName: string;
  timeZone: string;
  status: AccountStatus;
  role?: AccountRole;
  note?: string;
  /** PHC string, or null for a passkey-only account. */
  passwordHash: string | null;
  /** Plain base32 secret (encrypted here), or null. */
  totpSecret: string | null;
  /** The step of the code that proved the secret (it cannot be used again). */
  totpStep: number | null;
  /** WebAuthn user handle; made here when the sign-up did not need one yet. */
  webauthnUserId?: string;
}

export const newWebauthnUserId = (): string => randomBytes(32).toString("base64url");

/** Inserts an account. The caller checks the username is free (UNIQUE refuses it otherwise). */
export function insertAccount(tx: Tx, dataKey: Buffer, nowIso: string, input: NewAccount): AccountRow {
  return tx
    .insert(accounts)
    .values({
      username: input.username,
      displayName: input.displayName,
      color: PROJECT_COLORS[0],
      timeZone: input.timeZone,
      role: input.role ?? "user",
      status: input.status,
      signupNote: input.note ?? "",
      passwordHash: input.passwordHash,
      passwordChangedAt: input.passwordHash ? nowIso : null,
      totpSecretEnc: input.totpSecret ? encryptSecret(dataKey, input.totpSecret, TOTP_PURPOSE) : null,
      totpLastStep: input.totpSecret ? input.totpStep : null,
      totpSince: input.totpSecret ? nowIso : null,
      webauthnUserId: input.webauthnUserId ?? newWebauthnUserId(),
      createdAt: nowIso,
      updatedAt: nowIso,
      approvedAt: input.status === "active" ? nowIso : null,
    })
    .returning()
    .get();
}

/** Replaces the account's recovery codes with 10 new ones and returns them (the only time they are shown). */
export function replaceRecoveryCodes(tx: Tx, accountId: number, nowIso: string): string[] {
  tx.delete(recoveryCodes).where(eq(recoveryCodes.accountId, accountId)).run();
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  for (const code of codes) {
    tx.insert(recoveryCodes)
      .values({ accountId, codeHash: sha256Hex(code), createdAt: nowIso })
      .run();
  }
  return codes;
}

export const recoveryCodesLeft = (tx: Tx, accountId: number): number =>
  tx
    .select()
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.accountId, accountId), isNull(recoveryCodes.usedAt)))
    .all().length;

/** Uses up a recovery code (normalized). Returns false when it is unknown or used. */
export function useRecoveryCode(tx: Tx, accountId: number, code: string, nowIso: string): boolean {
  return (
    tx
      .update(recoveryCodes)
      .set({ usedAt: nowIso })
      .where(
        and(
          eq(recoveryCodes.accountId, accountId),
          eq(recoveryCodes.codeHash, sha256Hex(code)),
          isNull(recoveryCodes.usedAt),
        ),
      )
      .run().changes > 0
  );
}

/** The account page's view of the account (no secrets, only which factors exist and since when). */
export function toProfile(tx: Tx, row: AccountRow): AccountProfile {
  const passkeyCount =
    tx.select({ n: count() }).from(passkeys).where(eq(passkeys.accountId, row.id)).get()?.n ?? 0;
  return {
    ...toBrief(row),
    timeZone: row.timeZone,
    createdAt: row.createdAt,
    security: {
      password: row.passwordHash !== null,
      passwordChangedAt: row.passwordChangedAt,
      totpSince: row.totpSince,
      passkeys: passkeyCount,
      recoveryCodesLeft: recoveryCodesLeft(tx, row.id),
      loginResetAt: row.loginResetAt,
    },
  };
}

export function updateAccount(tx: Tx, id: number, nowIso: string, input: UpdateAccount): void {
  tx.update(accounts)
    .set({
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}),
      updatedAt: nowIso,
    })
    .where(eq(accounts.id, id))
    .run();
}

/** Whether another active admin exists (the last admin cannot delete itself). */
export const otherActiveAdmin = (tx: Tx, id: number): boolean =>
  (tx
    .select({ n: count() })
    .from(accounts)
    .where(and(eq(accounts.role, "admin"), eq(accounts.status, "active"), ne(accounts.id, id)))
    .get()?.n ?? 0) > 0;

/**
 * Deletes an account: its row, and through ON DELETE CASCADE every row of its data, sessions, tokens,
 * passkeys and codes; then its files folder, its restore safety copies and staged restores. `inTx` runs
 * in the same transaction (the admin log line).
 */
export function deleteAccount(db: Db, config: Config, row: AccountRow, inTx?: (tx: Tx) => void): void {
  db.transaction((tx) => {
    inTx?.(tx);
    // The search index is a virtual table without foreign keys: it does not cascade.
    removeAccountFromIndex(tx, row.id);
    const deleted = tx.delete(accounts).where(eq(accounts.id, row.id)).run();
    if (deleted.changes === 0)
      throw new ApiError("not_found", `Account ${row.id} does not exist. Check the id.`);
  });
  rmSync(join(config.filesDir, String(row.id)), { recursive: true, force: true });
  rmSync(join(config.backupDir, "accounts", String(row.id)), { recursive: true, force: true });
  cleanStaged(config.dataDir, new Date(), row.id);
}
