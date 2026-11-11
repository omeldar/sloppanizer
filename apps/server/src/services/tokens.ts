import { createHash, randomInt } from "node:crypto";
import { type ApiToken, TOKEN_PATTERN, TOKEN_PREFIX_LENGTH, type TokenScope } from "@organizer/shared";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/index.ts";
import { apiTokens } from "../db/schema.ts";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** last_used_at is written at most this often per token. */
const LAST_USED_THROTTLE_MS = 60_000;

export function generateRawToken(): string {
  let body = "";
  for (let i = 0; i < 40; i++) body += BASE62[randomInt(BASE62.length)];
  return `org_${body}`;
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

/** Creates a token and returns the raw value once; only its sha256 hash is stored. */
export function createToken(db: Db, clock: Clock, input: NewToken): { token: ApiToken; raw: string } {
  const raw = generateRawToken();
  const row = db
    .insert(apiTokens)
    .values({
      name: input.name,
      prefix: raw.slice(0, TOKEN_PREFIX_LENGTH),
      tokenHash: hashToken(raw),
      scope: input.scope,
      createdAt: clock().toISOString(),
      expiresAt: input.expiresAt ?? null,
    })
    .returning()
    .get();
  return { token: toApiToken(row), raw };
}

export function listTokens(db: Db): ApiToken[] {
  return db
    .select()
    .from(apiTokens)
    .orderBy(desc(apiTokens.createdAt), desc(apiTokens.id))
    .all()
    .map(toApiToken);
}

/** Marks a token revoked. Returns false when it does not exist. */
export function revokeToken(db: Db, clock: Clock, id: number): boolean {
  const row = db.select().from(apiTokens).where(eq(apiTokens.id, id)).get();
  if (!row) return false;
  db.update(apiTokens)
    .set({ revokedAt: clock().toISOString() })
    .where(and(eq(apiTokens.id, id), isNull(apiTokens.revokedAt)))
    .run();
  return true;
}

/** The token for a raw value, if it is valid now (not revoked, not expired). Updates last_used_at. */
export function verifyToken(db: Db, clock: Clock, raw: string): TokenRow | null {
  if (!TOKEN_PATTERN.test(raw)) return null;
  const row = db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, hashToken(raw)))
    .get();
  if (!row || row.revokedAt !== null) return null;
  const now = clock();
  if (row.expiresAt !== null && Date.parse(row.expiresAt) <= now.getTime()) return null;
  if (row.lastUsedAt === null || now.getTime() - Date.parse(row.lastUsedAt) >= LAST_USED_THROTTLE_MS) {
    db.update(apiTokens).set({ lastUsedAt: now.toISOString() }).where(eq(apiTokens.id, row.id)).run();
  }
  return row;
}
