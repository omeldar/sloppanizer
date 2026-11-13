import { and, eq, isNull, lte, or } from "drizzle-orm";
import { loginThrottle } from "../../db/auth-schema.ts";
import type { Tx } from "../context.ts";

/**
 * Login lockout per typed username (normalized), for names that exist and names that do not alike:
 * 5 failures in a row lock the name for 1 minute, each further failure doubles the lock up to 60 minutes,
 * a success clears it. Stored in the database so a restart does not lift a lock.
 */

export const FREE_FAILURES = 5;
const FIRST_LOCK_MS = 60_000;
const MAX_LOCK_MS = 60 * 60_000;
const KEEP_MS = 7 * 24 * 3600_000;

/** The key of a typed username (what the login form sent, trimmed and lowercased by the schema). */
export const nameKey = (username: string): string => username.trim().toLowerCase().slice(0, 64);

/** Seconds left on a lock of this name, or 0. */
export function lockedFor(tx: Tx, key: string, nowMs: number): number {
  const row = tx.select().from(loginThrottle).where(eq(loginThrottle.nameKey, key)).get();
  if (!row?.lockedUntil) return 0;
  const left = Date.parse(row.lockedUntil) - nowMs;
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

export const lockDurationMs = (failures: number): number =>
  failures < FREE_FAILURES ? 0 : Math.min(MAX_LOCK_MS, FIRST_LOCK_MS * 2 ** (failures - FREE_FAILURES));

/** Counts a failure; returns the lock in seconds it caused (0 when none yet). */
export function recordFailure(tx: Tx, key: string, nowMs: number): number {
  const row = tx.select().from(loginThrottle).where(eq(loginThrottle.nameKey, key)).get();
  const failures = (row?.failures ?? 0) + 1;
  const lockMs = lockDurationMs(failures);
  const values = {
    failures,
    lockedUntil: lockMs > 0 ? new Date(nowMs + lockMs).toISOString() : null,
    lastFailureAt: new Date(nowMs).toISOString(),
  };
  tx.insert(loginThrottle)
    .values({ nameKey: key, ...values })
    .onConflictDoUpdate({ target: loginThrottle.nameKey, set: values })
    .run();
  return Math.ceil(lockMs / 1000);
}

export function clearFailures(tx: Tx, key: string): void {
  tx.delete(loginThrottle).where(eq(loginThrottle.nameKey, key)).run();
}

/** Until when the name is locked (ISO), or null. */
export function lockedUntil(tx: Tx, key: string, nowMs: number): string | null {
  const row = tx.select().from(loginThrottle).where(eq(loginThrottle.nameKey, key)).get();
  return row?.lockedUntil && Date.parse(row.lockedUntil) > nowMs ? row.lockedUntil : null;
}

/** Deletes rows older than 7 days whose lock is over (hourly job). */
export function pruneThrottle(tx: Tx, nowMs: number): number {
  const now = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - KEEP_MS).toISOString();
  return tx
    .delete(loginThrottle)
    .where(
      and(
        lte(loginThrottle.lastFailureAt, cutoff),
        or(isNull(loginThrottle.lockedUntil), lte(loginThrottle.lockedUntil, now)),
      ),
    )
    .run().changes;
}
