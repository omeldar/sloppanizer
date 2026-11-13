import { createHmac } from "node:crypto";
import { safeEqual } from "./crypto.ts";

/** RFC 6238 TOTP: HMAC-SHA1, 30 s steps, 6 digits, accepted window one step back and one ahead. */

export const TOTP_STEP_SECONDS = 30;
const DIGITS = 6;
const WINDOW = 1;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(value: string): Buffer {
  const clean = value.toUpperCase().replace(/=+$/, "");
  let bits = 0;
  let buffer = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error("not base32");
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP (RFC 4226) for one counter value. */
export function hotp(key: Buffer, counter: number, digits = DIGITS, algorithm = "sha1"): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, key).update(message).digest();
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export const totpStep = (nowMs: number): number => Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);

/** The code of a base32 secret at a moment (dev helper and tests). */
export const totpCode = (secret: string, nowMs: number): string =>
  hotp(base32Decode(secret), totpStep(nowMs));

/**
 * The step a code matches within the window, or null. Steps at or below `lastStep` are refused, so a
 * code (and every older one) works only once.
 */
export function verifyTotp(
  secret: string,
  code: string,
  nowMs: number,
  lastStep: number | null,
): number | null {
  const key = base32Decode(secret);
  const current = totpStep(nowMs);
  let matched: number | null = null;
  // Check every step of the window so the time taken does not tell which one matched.
  for (let step = current - WINDOW; step <= current + WINDOW; step++) {
    if (safeEqual(hotp(key, step), code) && matched === null) matched = step;
  }
  if (matched === null) return null;
  if (lastStep !== null && matched <= lastStep) return null;
  return matched;
}
