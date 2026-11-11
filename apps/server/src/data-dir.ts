import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DB_FILE = "organizer.db";
export const SECRET_FILE = "secret";

/** Creates the data dir (0700) if needed and tightens its mode. */
export function ensureDataDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
}

/** The cookie signing key; generated (0600) on first start. */
export function loadSecret(dataDir: string): string {
  const path = join(dataDir, SECRET_FILE);
  try {
    writeFileSync(path, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  chmodSync(path, 0o600);
  const secret = readFileSync(path, "utf8").trim();
  if (secret.length < 32)
    throw new Error(`The secret file ${path} is too short. Delete it to generate a new one.`);
  return secret;
}

/** Writes a file only the owner can read (0600), replacing an existing one. */
export function writePrivateFile(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}
