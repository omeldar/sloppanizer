import type { FolderExport, Settings } from "@organizer/shared";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Ctx } from "./context.ts";
import { buildExport } from "./export.ts";
import { getSetting, setSetting } from "./settings.ts";
import { LAST_EXPORT_AT } from "./stats.ts";

/** "Write to folder" keeps this many zips in <data dir>/exports; older ones go after a write. */
export const FOLDER_EXPORT_KEEP = 4;
export const LAST_FOLDER_EXPORT = "lastFolderExport";

const EXPORT_FILE = /^organizer-export-(\d{8}-\d{6})(?:-(\d+))?\.zip$/;

/** Newest first: by the time stamp in the name, then by the "-2", "-3" suffix of same-second files. */
function newestFirst(a: string, b: string): number {
  const [, stampA = "", nA = "1"] = EXPORT_FILE.exec(a) ?? [];
  const [, stampB = "", nB = "1"] = EXPORT_FILE.exec(b) ?? [];
  return stampB.localeCompare(stampA) || Number(nB) - Number(nA);
}

export interface FolderDeps extends Ctx {
  dataDir: string;
  attachmentsDir: string;
  version: string;
}

/** <data dir>/exports, created 0700 when needed. */
export function exportDir(dataDir: string): string {
  const dir = join(dataDir, "exports");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
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

/** The export zips in the folder, newest first (file names carry the local time). */
export function listFolderExports(dataDir: string): FolderExport[] {
  const dir = exportDir(dataDir);
  return readdirSync(dir)
    .filter((name) => EXPORT_FILE.test(name))
    .toSorted(newestFirst)
    .map((fileName) => {
      const path = join(dir, fileName);
      const stat = statSync(path);
      return { at: stat.mtime.toISOString(), path, fileName, bytes: stat.size };
    });
}

/**
 * Writes a full export into <data dir>/exports, records it (lastExportAt, lastFolderExport) and
 * then deletes all but the newest FOLDER_EXPORT_KEEP zips there.
 */
export async function writeFolderExport(deps: FolderDeps): Promise<FolderExport> {
  const dir = exportDir(deps.dataDir);
  const { fileName: wanted, stream } = buildExport(deps, {
    attachmentsDir: deps.attachmentsDir,
    appVersion: deps.version,
  });
  const fileName = freeName(dir, wanted);
  const path = join(dir, fileName);
  const bytes = await writeFileAtomically(stream, path);
  const result: FolderExport = { at: deps.clock().toISOString(), path, fileName, bytes };
  setSetting(deps.db, LAST_FOLDER_EXPORT, result);
  for (const old of listFolderExports(deps.dataDir).slice(FOLDER_EXPORT_KEEP))
    rmSync(old.path, { force: true });
  return result;
}

/** What the Settings page shows. */
export function getSettings(deps: FolderDeps): Settings {
  return {
    exportDir: exportDir(deps.dataDir),
    folderExportKeep: FOLDER_EXPORT_KEEP,
    dataDir: deps.dataDir,
    lastExportAt: getSetting<string>(deps.db, LAST_EXPORT_AT),
    lastFolderExport: getSetting<FolderExport>(deps.db, LAST_FOLDER_EXPORT),
    version: deps.version,
  };
}
