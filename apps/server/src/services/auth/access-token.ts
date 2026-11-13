import { createHmac } from "node:crypto";
import { safeEqual } from "./crypto.ts";

/**
 * Short-lived access tokens of browser sessions: `spa_<base64url payload>.<base64url HMAC-SHA256>`,
 * payload { sid, aid, exp }. The signature only saves a database lookup for forged tokens: every request
 * still loads the session and the account, so a revoke or a disable acts at once.
 */

export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const PREFIX = "spa_";
const PATTERN = /^spa_([A-Za-z0-9_-]{10,200})\.([A-Za-z0-9_-]{43})$/;

export interface AccessPayload {
  /** Session id. */
  sid: string;
  /** Account id. */
  aid: number;
  /** Expiry, ms since the epoch. */
  exp: number;
}

/** Derives the signing key from the instance secret (its own purpose, so the secret is not reused as is). */
export const accessKey = (secret: string): Buffer =>
  createHmac("sha256", secret).update("sloppanizer access token v1").digest();

const sign = (key: Buffer, body: string): string =>
  createHmac("sha256", key).update(body).digest("base64url");

export function mintAccessToken(key: Buffer, payload: AccessPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${PREFIX}${body}.${sign(key, body)}`;
}

export const looksLikeAccessToken = (raw: string): boolean => raw.startsWith(PREFIX);

/** The payload of a well-signed, unexpired token, else null. */
export function readAccessToken(key: Buffer, raw: string, nowMs: number): AccessPayload | null {
  const match = PATTERN.exec(raw);
  if (!match) return null;
  const [, body, signature] = match as unknown as [string, string, string];
  if (!safeEqual(sign(key, body), signature)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const { sid, aid, exp } = payload as Record<string, unknown>;
  if (typeof sid !== "string" || !/^[0-9a-f]{32}$/.test(sid)) return null;
  if (typeof aid !== "number" || !Number.isInteger(aid) || aid < 1) return null;
  if (typeof exp !== "number" || exp <= nowMs) return null;
  return { sid, aid, exp };
}
