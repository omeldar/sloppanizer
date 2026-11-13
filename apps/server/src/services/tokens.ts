import { createHash, randomInt } from "node:crypto";
import {
  type ApiToken,
  SESSION_ACTOR,
  TOKEN_PATTERN,
  TOKEN_PREFIX_LENGTH,
  type TokenScope,
} from "@organizer/shared";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/index.ts";
import { apiTokens } from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import { foldCase } from "./text.ts";

/** API tokens belong to one account; everything here is scoped by the caller's account id. */

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** last_used_at is written at most this often per token. */
const LAST_USED_THROTTLE_MS = 60_000;
export const MAX_ACTIVE_TOKENS = 20;

export function generateRawToken(): string {
  let body = "";
  for (let i = 0; i < 40; i++) body += BASE62[randomInt(BASE62.length)];
  return `spz_${body}`;
}

export const hashToken = (raw: string): string => createHash("sha256").update(raw).digest("hex");

type TokenRow = typeof apiTokens.$inferSelect;

export const toApiToken = (row: TokenRow): ApiToken => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  scope: row.scope,
  createdAt: row.createdAt,
  lastUsedAt: row.lastUsedAt,
  expiresAt: row.expiresAt,
  revokedAt: row.revokedAt,
});

export interface NewToken {
  name: string;
  scope: TokenScope;
  expiresAt?: string | null | undefined;
}

const isActive = (row: TokenRow, nowMs: number): boolean =>
  row.revokedAt === null && (row.expiresAt === null || Date.parse(row.expiresAt) > nowMs);

/** Creates a token of the account and returns the raw value once; only its sha256 hash is stored. */
export function createToken(
  db: Db,
  clock: Clock,
  accountId: number,
  input: NewToken,
): { token: ApiToken; raw: string } {
  // Comments and history name the actor by token name, so names must not be shared or look like the session.
  const key = foldCase(input.name);
  if (key === SESSION_ACTOR) {
    throw new ApiError("validation_failed", 'The name "you" is reserved for the browser session.');
  }
  const nowMs = clock().getTime();
  // Few tokens, and SQLite's lower() folds ASCII only: compare in JS.
  const active = db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.accountId, accountId), isNull(apiTokens.revokedAt)))
    .all()
    .filter((row) => isActive(row, nowMs));
  const taken = active.find((t) => foldCase(t.name) === key);
  if (taken) {
    throw new ApiError(
      "conflict",
      `A token named "${taken.name}" exists already. Pick another name, or revoke that token first.`,
    );
  }
  if (active.length >= MAX_ACTIVE_TOKENS) {
    throw new ApiError(
      "conflict",
      `This account has ${MAX_ACTIVE_TOKENS} active tokens, the most it can have. Revoke one you no longer use.`,
    );
  }
  const raw = generateRawToken();
  const row = db
    .insert(apiTokens)
    .values({
      accountId,
      name: input.name,
      prefix: raw.slice(0, TOKEN_PREFIX_LENGTH),
      tokenHash: hashToken(raw),
      scope: input.scope,
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: input.expiresAt ?? null,
    })
    .returning()
    .get();
  return { token: toApiToken(row), raw };
}

export function listTokens(db: Db, accountId: number): ApiToken[] {
  return db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.accountId, accountId))
    .orderBy(desc(apiTokens.createdAt), desc(apiTokens.id))
    .all()
    .map(toApiToken);
}

/** Marks a token of the account revoked. Returns false when the account has no such token. */
export function revokeToken(db: Db, clock: Clock, accountId: number, id: number): boolean {
  const scope = and(eq(apiTokens.id, id), eq(apiTokens.accountId, accountId));
  const row = db.select().from(apiTokens).where(scope).get();
  if (!row) return false;
  db.update(apiTokens)
    .set({ revokedAt: clock().toISOString() })
    .where(and(scope, isNull(apiTokens.revokedAt)))
    .run();
  return true;
}

/**
 * The token for a raw value, if it is valid now (not revoked, not expired). Updates last_used_at. The
 * caller checks that its account is active.
 */
export function verifyToken(db: Db, clock: Clock, raw: string): TokenRow | null {
  if (!TOKEN_PATTERN.test(raw)) return null;
  const row = db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, hashToken(raw)))
    .get();
  const now = clock();
  if (!row || !isActive(row, now.getTime())) return null;
  if (row.lastUsedAt === null || now.getTime() - Date.parse(row.lastUsedAt) >= LAST_USED_THROTTLE_MS) {
    db.update(apiTokens).set({ lastUsedAt: now.toISOString() }).where(eq(apiTokens.id, row.id)).run();
  }
  return row;
}
