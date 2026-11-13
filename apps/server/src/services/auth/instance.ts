import { type AdminAction, type AdminEvent, normalizeOneTimeCode } from "@organizer/shared";
import { desc, eq, lt } from "drizzle-orm";
import { accounts, adminEvents, instanceSettings } from "../../db/auth-schema.ts";
import type { Tx } from "../context.ts";
import { newOneTimeCode, safeEqual, sha256Hex } from "./crypto.ts";

/** Instance-wide settings, the admin log and the first-admin setup code. */

export function getInstanceSetting<T>(tx: Tx, key: string): T | null {
  const row = tx.select().from(instanceSettings).where(eq(instanceSettings.key, key)).get();
  return row ? (JSON.parse(row.value) as T) : null;
}

export function setInstanceSetting(tx: Tx, key: string, value: unknown): void {
  const text = JSON.stringify(value);
  tx.insert(instanceSettings)
    .values({ key, value: text })
    .onConflictDoUpdate({ target: instanceSettings.key, set: { value: text } })
    .run();
}

export function deleteInstanceSetting(tx: Tx, key: string): void {
  tx.delete(instanceSettings).where(eq(instanceSettings.key, key)).run();
}

// ---------------------------------------------------------------------------------------------------------
// Admin log: metadata only (who did what to which username), never account contents.

export const ADMIN_EVENTS_KEEP = 1000;

export function logAdminEvent(
  tx: Tx,
  at: string,
  actor: string,
  action: AdminAction,
  target: string | null,
  data: Record<string, unknown> = {},
): void {
  tx.insert(adminEvents)
    .values({ at, actor, action, target, data: JSON.stringify(data) })
    .run();
}

export function listAdminEvents(tx: Tx, limit = 200): AdminEvent[] {
  return tx
    .select()
    .from(adminEvents)
    .orderBy(desc(adminEvents.id))
    .limit(limit)
    .all()
    .map((row) => ({
      id: row.id,
      at: row.at,
      actor: row.actor,
      action: row.action as AdminAction,
      target: row.target,
    }));
}

/** Keeps the newest 1000 events (hourly job). */
export function pruneAdminEvents(tx: Tx): number {
  const cutoff = tx
    .select({ id: adminEvents.id })
    .from(adminEvents)
    .orderBy(desc(adminEvents.id))
    .limit(1)
    .offset(ADMIN_EVENTS_KEEP - 1)
    .get();
  if (!cutoff) return 0;
  return tx.delete(adminEvents).where(lt(adminEvents.id, cutoff.id)).run().changes;
}

// ---------------------------------------------------------------------------------------------------------
// First admin

const SETUP_CODE_KEY = "setupCodeHash";

export const adminExists = (tx: Tx): boolean =>
  tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.role, "admin")).limit(1).get() !==
  undefined;

/**
 * At start: while no admin exists and no fixed code is configured, a new setup code replaces the old
 * one and is returned (to be logged once). Null when an admin exists or the env fixes the code.
 */
export function prepareSetupCode(tx: Tx, fixedCode: string | null): string | null {
  if (adminExists(tx)) {
    deleteInstanceSetting(tx, SETUP_CODE_KEY);
    return null;
  }
  if (fixedCode !== null) {
    setInstanceSetting(tx, SETUP_CODE_KEY, sha256Hex(fixedCode));
    return null;
  }
  const code = newOneTimeCode();
  setInstanceSetting(tx, SETUP_CODE_KEY, sha256Hex(normalizeOneTimeCode(code)));
  return code;
}

/** Whether a typed setup code is the current one (constant time). */
export function setupCodeMatches(tx: Tx, typed: string): boolean {
  const stored = getInstanceSetting<string>(tx, SETUP_CODE_KEY);
  const hash = sha256Hex(normalizeOneTimeCode(typed));
  return stored !== null && safeEqual(hash, stored);
}

/** The code is single use: gone once the admin exists. */
export const clearSetupCode = (tx: Tx): void => deleteInstanceSetting(tx, SETUP_CODE_KEY);
