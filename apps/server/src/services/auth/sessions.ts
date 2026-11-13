import {
  MAX_SESSIONS,
  type RevokeReason,
  type SessionInfo,
  type SessionMethod,
  type SessionTokens,
} from "@organizer/shared";
import { and, asc, desc, eq, isNull, lte, or } from "drizzle-orm";
import type { Db } from "../../db/index.ts";
import { sessions } from "../../db/auth-schema.ts";
import { type AccountRow, toBrief } from "../accounts.ts";
import type { Tx } from "../context.ts";
import { ACCESS_TOKEN_TTL_MS, mintAccessToken } from "./access-token.ts";
import { randomBase62, randomHex, sha256Hex } from "./crypto.ts";
import { deviceName } from "./user-agent.ts";

/**
 * Browser sessions. A refresh token (`spr_` + 43 base62, sha256 stored) rotates on every refresh. The
 * previous token still works within 60 s of the rotation (a lost answer, two tabs racing) and rotates
 * again; later it counts as stolen and revokes the whole session.
 */

const DAY_MS = 24 * 3600 * 1000;
export const SESSION_IDLE_MS = 30 * DAY_MS;
export const SESSION_MAX_MS = 90 * DAY_MS;
export const REFRESH_GRACE_MS = 60 * 1000;
/** last_used_at and ip are written at most this often per session. */
const TOUCH_MS = 60 * 1000;

export type SessionRow = typeof sessions.$inferSelect;

const iso = (ms: number): string => new Date(ms).toISOString();

export const newRefreshToken = (): string => `spr_${randomBase62(43)}`;
const REFRESH_PATTERN = /^spr_[0-9A-Za-z]{43}$/;

/** Whether a session can be used now: not revoked, not past its 90 days, used within 30 days. */
export const isLive = (row: SessionRow, nowMs: number): boolean =>
  row.revokedAt === null &&
  Date.parse(row.expiresAt) > nowMs &&
  Date.parse(row.lastUsedAt) + SESSION_IDLE_MS > nowMs;

export interface NewSession {
  accountId: number;
  method: SessionMethod;
  userAgent: string;
  ip: string | null;
}

/** Live sessions of an account, oldest first. */
function liveSessions(tx: Tx, accountId: number, nowMs: number): SessionRow[] {
  return tx
    .select()
    .from(sessions)
    .where(and(eq(sessions.accountId, accountId), isNull(sessions.revokedAt)))
    .orderBy(asc(sessions.createdAt))
    .all()
    .filter((row) => isLive(row, nowMs));
}

/** Starts a session; beyond 20 live ones the oldest is revoked (reason limit). */
export function createSession(
  tx: Tx,
  nowMs: number,
  input: NewSession,
): { session: SessionRow; refreshToken: string } {
  const refreshToken = newRefreshToken();
  const now = iso(nowMs);
  const session = tx
    .insert(sessions)
    .values({
      id: randomHex(16),
      accountId: input.accountId,
      refreshHash: sha256Hex(refreshToken),
      method: input.method,
      authenticatedAt: now,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: iso(nowMs + SESSION_MAX_MS),
      userAgent: input.userAgent.slice(0, 200),
      ip: input.ip,
    })
    .returning()
    .get();
  const live = liveSessions(tx, input.accountId, nowMs);
  for (const old of live.slice(0, Math.max(0, live.length - MAX_SESSIONS))) {
    revokeById(tx, nowMs, old.id, "limit");
  }
  return { session, refreshToken };
}

/** What a sign-in or a refresh answers: a new 15 minute access token plus the session's refresh token. */
export function sessionTokens(
  accessKey: Buffer,
  nowMs: number,
  account: AccountRow,
  session: SessionRow,
  refreshToken: string,
  recoveryCodesLeft: number | null = null,
): SessionTokens {
  const exp = nowMs + ACCESS_TOKEN_TTL_MS;
  return {
    accessToken: mintAccessToken(accessKey, { sid: session.id, aid: account.id, exp }),
    accessExpiresAt: iso(exp),
    refreshToken,
    sessionId: session.id,
    account: toBrief(account),
    recoveryCodesLeft,
  };
}

export type RefreshOutcome =
  | { kind: "rotated"; session: SessionRow; refreshToken: string }
  /** Unknown token, or its session is revoked, expired or idle too long. */
  | { kind: "invalid" }
  /** An old token came back after the grace time: the session was revoked. */
  | { kind: "reused"; session: SessionRow };

/** Rotates a refresh token (see the file comment for the grace and reuse rules). */
export function rotateRefreshToken(
  db: Db,
  nowMs: number,
  raw: string,
  /** Runs once the session is known, before anything changes (per-session rate limit; may throw). */
  beforeRotate: (sessionId: string) => void = () => {},
): RefreshOutcome {
  if (!REFRESH_PATTERN.test(raw)) return { kind: "invalid" };
  const hash = sha256Hex(raw);
  return db.transaction((tx) => {
    const current = tx.select().from(sessions).where(eq(sessions.refreshHash, hash)).get();
    const previous = current
      ? undefined
      : tx.select().from(sessions).where(eq(sessions.prevRefreshHash, hash)).get();
    const row = current ?? previous;
    if (!row || !isLive(row, nowMs)) return { kind: "invalid" } as const;
    beforeRotate(row.id);
    if (previous) {
      const rotatedMs = row.rotatedAt ? Date.parse(row.rotatedAt) : 0;
      if (nowMs - rotatedMs > REFRESH_GRACE_MS) {
        revokeById(tx, nowMs, row.id, "refresh_reuse");
        return { kind: "reused", session: row } as const;
      }
    }
    const refreshToken = newRefreshToken();
    const session = tx
      .update(sessions)
      .set({
        refreshHash: sha256Hex(refreshToken),
        // Within the grace the window stays anchored at the first rotation, so it cannot be stretched.
        prevRefreshHash: hash,
        rotatedAt: previous ? row.rotatedAt : iso(nowMs),
        lastUsedAt: iso(nowMs),
      })
      .where(eq(sessions.id, row.id))
      .returning()
      .get();
    return { kind: "rotated", session, refreshToken } as const;
  });
}

/** The live session of an access token; refreshes last_used_at and ip at most once a minute. */
export function useSession(
  db: Db,
  nowMs: number,
  id: string,
  accountId: number,
  ip: string | null,
): SessionRow | null {
  const row = db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, id), eq(sessions.accountId, accountId)))
    .get();
  if (!row || !isLive(row, nowMs)) return null;
  if (nowMs - Date.parse(row.lastUsedAt) >= TOUCH_MS || row.ip !== ip) {
    db.update(sessions)
      .set({ lastUsedAt: iso(nowMs), ip })
      .where(eq(sessions.id, id))
      .run();
  }
  return row;
}

function revokeById(tx: Tx, nowMs: number, id: string, reason: RevokeReason): boolean {
  const result = tx
    .update(sessions)
    .set({ revokedAt: iso(nowMs), revokeReason: reason })
    .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)))
    .run();
  return result.changes > 0;
}

/** Revokes one session of the account; false when it is not the account's or not live. */
export function revokeSession(
  tx: Tx,
  nowMs: number,
  accountId: number,
  id: string,
  reason: RevokeReason,
): boolean {
  const row = tx
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, id), eq(sessions.accountId, accountId)))
    .get();
  if (!row || !isLive(row, nowMs)) return false;
  return revokeById(tx, nowMs, id, reason);
}

/** Revokes every live session of the account (but `exceptId`). Returns how many. */
export function revokeAccountSessions(
  tx: Tx,
  nowMs: number,
  accountId: number,
  reason: RevokeReason,
  exceptId?: string,
): number {
  let count = 0;
  for (const row of liveSessions(tx, accountId, nowMs)) {
    if (row.id !== exceptId && revokeById(tx, nowMs, row.id, reason)) count++;
  }
  return count;
}

export function markAuthenticated(tx: Tx, nowMs: number, id: string): void {
  tx.update(sessions)
    .set({ authenticatedAt: iso(nowMs) })
    .where(eq(sessions.id, id))
    .run();
}

export const countLiveSessions = (tx: Tx, accountId: number, nowMs: number): number =>
  liveSessions(tx, accountId, nowMs).length;

export function listSessions(
  tx: Tx,
  nowMs: number,
  accountId: number,
  currentId: string | null,
): SessionInfo[] {
  return tx
    .select()
    .from(sessions)
    .where(and(eq(sessions.accountId, accountId), isNull(sessions.revokedAt)))
    .orderBy(desc(sessions.lastUsedAt))
    .all()
    .filter((row) => isLive(row, nowMs))
    .map((row) => ({
      id: row.id,
      current: row.id === currentId,
      method: row.method,
      device: deviceName(row.userAgent),
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      expiresAt: row.expiresAt,
      ip: row.ip,
    }));
}

/** Deletes sessions revoked or expired more than 30 days ago (hourly job). */
export function pruneSessions(tx: Tx, nowMs: number): number {
  const cutoff = iso(nowMs - 30 * DAY_MS);
  const idleCutoff = iso(nowMs - SESSION_IDLE_MS - 30 * DAY_MS);
  return tx
    .delete(sessions)
    .where(
      or(
        lte(sessions.revokedAt, cutoff),
        lte(sessions.expiresAt, cutoff),
        lte(sessions.lastUsedAt, idleCutoff),
      ),
    )
    .run().changes;
}
