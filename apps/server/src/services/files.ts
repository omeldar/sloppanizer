import {
  chmodSync,
  closeSync,
  createWriteStream,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Small file helpers for zips the server writes (restore safety copies). */

/** Creates a folder only the owner can open (0700), with its parents, and returns its path. */
export function privateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

/** A name in `dir` that is not taken yet: "name.zip", else "name-2.zip", ... */
export function freeName(dir: string, fileName: string): string {
  const base = fileName.replace(/\.zip$/, "");
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? fileName : `${base}-${n}.zip`;
    try {
      statSync(join(dir, candidate));
    } catch {
      return candidate;
    }
  }
}

/**
 * Writes a stream to `path` safely: into "<path>.partial" (0600), fsync, then rename, so a crash
 * never leaves a half-written file under the real name. Returns the size in bytes.
 */
export async function writeFileAtomically(stream: Readable, path: string): Promise<number> {
  const partial = `${path}.partial`;
  try {
    await pipeline(stream, createWriteStream(partial, { mode: 0o600 }));
    const fd = openSync(partial, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(partial, 0o600);
    renameSync(partial, path);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
  return statSync(path).size;
}
