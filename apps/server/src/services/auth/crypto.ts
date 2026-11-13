import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Small crypto helpers of the auth services. Nothing here logs or returns secrets on errors. */

export const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Constant-time comparison of two strings (different lengths compare false without a shortcut on content). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Uniformly random characters of an alphabet (crypto.randomInt, no modulo bias). */
export function randomChars(length: number, alphabet: string): string {
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

export const randomBase32 = (length: number): string => randomChars(length, BASE32);
export const randomBase62 = (length: number): string => randomChars(length, BASE62);

/** Groups of 4 joined by dashes: "ABCD-EFGH-...". */
export const groupsOf4 = (value: string): string => value.match(/.{1,4}/g)?.join("-") ?? "";

/** 20 random base32 characters in groups of 4 (setup and reset codes, 100 bits). */
export const newOneTimeCode = (): string => groupsOf4(randomBase32(20));

/** `abcd-efgh-ijkl-mnop` (16 base32 characters, 80 bits). */
export const newRecoveryCode = (): string => groupsOf4(randomBase32(16).toLowerCase());

export const randomHex = (bytes: number): string => randomBytes(bytes).toString("hex");

// ---------------------------------------------------------------------------------------------------------
// Data key: encrypts authenticator secrets (AES-256-GCM).

export const DATA_KEY_FILE = "data-key";
const KEY_BYTES = 32;

export class DataKeyError extends Error {}

/** Decodes SLOPPANIZER_DATA_KEY (32 bytes base64). */
export function parseDataKey(value: string): Buffer {
  const text = value.trim();
  if (!/^[A-Za-z0-9+/]{43}=?$/.test(text)) {
    throw new DataKeyError(
      "SLOPPANIZER_DATA_KEY must be 32 bytes in base64. Make one with: openssl rand -base64 32",
    );
  }
  return Buffer.from(text, "base64");
}

/** The data key from the env, else (development only) a 0600 file in the data dir made on first start. */
export function loadDataKey(dataDir: string, fromEnv: Buffer | null): Buffer {
  if (fromEnv) return fromEnv;
  const path = join(dataDir, DATA_KEY_FILE);
  try {
    writeFileSync(path, `${randomBytes(KEY_BYTES).toString("base64")}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  chmodSync(path, 0o600);
  return parseDataKey(readFileSync(path, "utf8"));
}

const b64u = (buffer: Buffer): string => buffer.toString("base64url");

/** `v1:<iv>:<ciphertext>:<tag>` (base64url). The purpose is bound as additional data. */
export function encryptSecret(key: Buffer, plain: string, purpose: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(purpose));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${b64u(iv)}:${b64u(body)}:${b64u(cipher.getAuthTag())}`;
}

export class DecryptError extends Error {}

/** Throws DecryptError when the value was changed, made with another key or for another purpose. */
export function decryptSecret(key: Buffer, value: string, purpose: string): string {
  const parts = value.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") throw new DecryptError("unknown secret format");
  const [, iv, body, tag] = parts as [string, string, string, string];
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    throw new DecryptError("the secret cannot be decrypted with this data key");
  }
}
