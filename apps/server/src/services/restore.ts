import type { BackupFile, RestorePreview, RestoreResult } from "@organizer/shared";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { ATTACHMENTS_DIR, writePrivateFile } from "../data-dir.ts";
import { type Db, openDb, schemaVersion } from "../db/index.ts";
import { ApiError } from "../http/errors.ts";
import { now } from "./context.ts";
import { attachmentFileName, buildExport, EXPORT_TABLES, fileStamp } from "./export.ts";
import { type FolderDeps, freeName, writeFileAtomically } from "./folder-export.ts";
import { repairScopeConflicts } from "./labels.ts";
import { repairNameKeys } from "./name-keys.ts";
import { type ExportData, replaceAllData, RowError, type Sequences, tableColumns } from "./restore-data.ts";
import { rebuildSearchIndex } from "./search-index.ts";
import { getSetting, setSetting } from "./settings.ts";
import { inflateEntry, readCentralDirectory, readEntry, ZipError, type ZipEntryInfo } from "./zip-reader.ts";

const MiB = 1024 * 1024;

export interface RestoreLimits {
  /** Largest upload (the zip itself). */
  uploadBytes: number;
  /** Largest data.json when unpacked. */
  dataJsonBytes: number;
  /** Everything in the archive together, unpacked. */
  totalBytes: number;
}

export const RESTORE_LIMITS: RestoreLimits = {
  uploadBytes: 1024 * MiB,
  dataJsonBytes: 512 * MiB,
  totalBytes: 4096 * MiB,
};

/** A staged upload stays this long. */
export const STAGE_TTL_MS = 60 * 60_000;
/** Safety copies kept in <data dir>/backups. */
export const BACKUPS_KEEP = 5;
export const RESTORE_IN_PROGRESS = "restoreInProgress";

const RESTORE_DIR = "restore";
const BACKUPS_DIR = "backups";
const BACKUP_FILE = /^organizer-before-restore-(\d{8}-\d{6})(?:-(\d+))?\.zip$/;
const MAX_PROBLEMS = 20;

/** Tables of each export format. */
const FORMAT_TABLES: Record<number, readonly string[]> = {
  1: ["projects", "labels", "people", "todos", "todo_labels", "todo_people", "events", "settings"],
  2: EXPORT_TABLES.filter((t) => t !== "todo_links"),
  // Format 3 adds todo_links (and manifest.sequences).
  3: EXPORT_TABLES,
};

export interface RestoreDeps extends FolderDeps {
  limits: RestoreLimits;
  /** One restore at a time (per app). */
  restoreLock: { busy: boolean };
}

interface Manifest {
  app: string;
  format: number;
  exportedAt: string;
  appVersion: string;
  schemaVersion: number;
  attachments?: { missing?: number[] };
  sequences?: Sequences;
}

interface AttachmentRowData {
  id: number;
  name: string;
  size: number;
  sha256: string;
}

interface Archive {
  zip: Buffer;
  entries: Map<string, ZipEntryInfo>;
  manifest: Manifest;
  data: ExportData;
}

interface StagedInfo {
  preview: RestorePreview;
}

class Problems {
  readonly list: string[] = [];
  add(message: string): void {
    this.list.push(message);
  }
  get any(): boolean {
    return this.list.length > 0;
  }
  error(): ApiError {
    const first = this.list[0] ?? "The file cannot be restored.";
    return new ApiError("validation_failed", `This file cannot be restored: ${first}`, {
      problems: this.list.slice(0, MAX_PROBLEMS),
    });
  }
}

function privateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

const restoreDir = (dataDir: string) => privateDir(join(dataDir, RESTORE_DIR));
const backupsDir = (dataDir: string) => privateDir(join(dataDir, BACKUPS_DIR));
const stagingDir = (dataDir: string, uploadId: string) =>
  join(dataDir, `${ATTACHMENTS_DIR}.restore-${uploadId}`);
const oldDir = (dataDir: string, uploadId: string) => join(dataDir, `${ATTACHMENTS_DIR}.old-${uploadId}`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---------- reading and checking an archive ----------

/** Lists the zip, refuses duplicates and oversize content, reads manifest.json and data.json. */
function readArchive(
  zip: Buffer,
  limits: RestoreLimits,
  currentSchema: number,
  problems: Problems,
): Archive | null {
  let list: ZipEntryInfo[];
  try {
    list = readCentralDirectory(zip);
  } catch (error) {
    problems.add(error instanceof ZipError ? error.message : "The file is not a readable zip archive.");
    return null;
  }
  const entries = new Map<string, ZipEntryInfo>();
  for (const entry of list) {
    if (entries.has(entry.name)) problems.add(`The archive has the entry "${entry.name}" twice.`);
    entries.set(entry.name, entry);
  }
  const declared = list.reduce((sum, e) => sum + e.size, 0);
  if (declared > limits.totalBytes) problems.add("The archive is larger than 4 GB when unpacked.");
  const manifestEntry = entries.get("manifest.json");
  const dataEntry = entries.get("data.json");
  if (!manifestEntry) problems.add("manifest.json is missing. Is this an organizer export?");
  if (!dataEntry) problems.add("data.json is missing. Is this an organizer export?");
  if (dataEntry && dataEntry.size > limits.dataJsonBytes) problems.add("data.json is larger than 512 MB.");
  if (problems.any || !manifestEntry || !dataEntry) return null;

  let manifest: Manifest;
  let data: unknown;
  try {
    manifest = JSON.parse(readEntry(zip, manifestEntry, MiB).toString("utf8")) as Manifest;
    data = JSON.parse(readEntry(zip, dataEntry, limits.dataJsonBytes).toString("utf8"));
  } catch (error) {
    problems.add(error instanceof ZipError ? error.message : "manifest.json or data.json is not valid JSON.");
    return null;
  }
  if (!isRecord(manifest) || manifest.app !== "organizer") {
    problems.add('manifest.json does not say app "organizer". Is this an organizer export?');
    return null;
  }
  if (!FORMAT_TABLES[manifest.format]) {
    problems.add(
      `Export format ${String(manifest.format)} is not known. Formats 1, 2 and 3 can be restored.`,
    );
    return null;
  }
  if (typeof manifest.schemaVersion !== "number" || manifest.schemaVersion > currentSchema) {
    problems.add("This export comes from a newer organizer. Update this one first.");
    return null;
  }
  if (typeof manifest.exportedAt !== "string" || typeof manifest.appVersion !== "string") {
    problems.add("manifest.json misses exportedAt or appVersion.");
    return null;
  }
  if (!isRecord(data)) {
    problems.add("data.json does not hold the tables.");
    return null;
  }
  return { zip, entries, manifest, data: data as ExportData };
}

/** SQLite column types as JSON types: integer, real or text (null always allowed). */
function typeProblem(type: string, value: unknown): boolean {
  if (value === null) return false;
  const t = type.toUpperCase();
  if (t.includes("INT")) return !Number.isInteger(value);
  if (t.includes("REAL")) return typeof value !== "number";
  if (t.includes("TEXT")) return typeof value !== "string";
  return false;
}

/** Tables of the format, every row an object whose columns exist now with fitting types. */
function checkTables(db: Db, archive: Archive, problems: Problems): void {
  const expected = FORMAT_TABLES[archive.manifest.format] ?? [];
  for (const table of Object.keys(archive.data)) {
    if (!expected.includes(table))
      problems.add(`data.json has a table "${table}" that format ${archive.manifest.format} does not have.`);
  }
  for (const table of expected) {
    const rows = archive.data[table];
    if (!Array.isArray(rows)) {
      problems.add(`data.json misses the table "${table}".`);
      continue;
    }
    const types = new Map(
      (db.$client.prepare(`PRAGMA table_info("${table}")`).all() as { name: string; type: string }[]).map(
        (c) => [c.name, c.type],
      ),
    );
    const columns = tableColumns(db.$client, table);
    for (const row of rows) {
      if (!isRecord(row)) {
        problems.add(`${table}: a row is not an object.`);
        break;
      }
      const unknown = Object.keys(row).filter((c) => !columns.has(c));
      if (unknown.length > 0) {
        problems.add(`${table}: unknown column ${unknown.join(", ")}.`);
        break;
      }
      const wrong = Object.keys(row).filter((c) => typeProblem(types.get(c) ?? "", row[c]));
      if (wrong.length > 0) {
        problems.add(
          `${table} ${String(row.id ?? row.key ?? "")}: wrong type in ${wrong.join(", ")}.`.replace(
            "  ",
            " ",
          ),
        );
        break;
      }
    }
  }
}

/** Loads the data into a scratch database, so FK, CHECK and UNIQUE problems show with table and id. */
function trialImport(dataDir: string, uploadId: string, archive: Archive, problems: Problems): void {
  const file = join(restoreDir(dataDir), `${uploadId}.db`);
  const scratch = openDb(file);
  const sqlite = scratch.$client;
  const rollback = new Error("rollback");
  try {
    sqlite.transaction(() => {
      try {
        replaceAllData(sqlite, archive.data, archive.manifest.sequences);
      } catch (error) {
        problems.add(
          error instanceof RowError
            ? error.message
            : `The data cannot be loaded: ${(error as Error).message}`,
        );
        throw rollback;
      }
      for (const row of sqlite.pragma("foreign_key_check") as {
        table: string;
        rowid: number;
        parent: string;
      }[]) {
        problems.add(`${row.table} ${row.rowid}: points to a missing row in ${row.parent}.`);
      }
      throw rollback;
    })();
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    sqlite.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
  }
}

interface AttachmentCheck {
  count: number;
  bytes: number;
  missing: number[];
  warnings: string[];
}

/** Receives the files while they are checked (apply writes them to the staging folder). */
interface FileSink {
  start(id: number): void;
  write(chunk: Uint8Array): void;
  end(): void;
}

/** Every attachment row needs its entry attachments/<id>-<name> with the right size and sha256. */
function checkAttachments(archive: Archive, problems: Problems, sink?: FileSink): AttachmentCheck {
  const rows = (archive.data.attachments ?? []) as unknown as AttachmentRowData[];
  const listedMissing = new Set(archive.manifest.attachments?.missing ?? []);
  const used = new Set<string>();
  const missing: number[] = [];
  let count = 0;
  let bytes = 0;
  for (const row of rows) {
    const name = `attachments/${attachmentFileName(row)}`;
    const entry = archive.entries.get(name);
    if (!entry) {
      if (listedMissing.has(row.id)) missing.push(row.id);
      else problems.add(`The file of attachment ${row.id} (${row.name}) is missing in the archive.`);
      continue;
    }
    used.add(name);
    const hash = createHash("sha256");
    let size: number;
    sink?.start(row.id);
    try {
      size = inflateEntry(archive.zip, entry, Math.max(row.size, 0) + 1, (chunk) => {
        hash.update(chunk);
        sink?.write(chunk);
      });
    } catch (error) {
      problems.add(error instanceof ZipError ? `Attachment ${row.id}: ${error.message}` : String(error));
      continue;
    } finally {
      sink?.end();
    }
    if (size !== row.size || hash.digest("hex") !== row.sha256) {
      problems.add(`The file of attachment ${row.id} (${row.name}) does not match its size or checksum.`);
      continue;
    }
    count += 1;
    bytes += size;
  }
  const warnings: string[] = [];
  if (missing.length > 0) {
    warnings.push(
      `${missing.length} file${missing.length > 1 ? "s were" : " was"} already missing when the export was made (attachment ${missing.join(", ")}).`,
    );
  }
  const extra = [...archive.entries.keys()].filter(
    (n) => n.startsWith("attachments/") && !used.has(n),
  ).length;
  if (extra > 0) {
    warnings.push(
      `${extra} file${extra > 1 ? "s" : ""} in attachments/ belong${extra > 1 ? "" : "s"} to no attachment and ${extra > 1 ? "are" : "is"} ignored.`,
    );
  }
  return { count, bytes, missing, warnings };
}

function liveCounts(db: Db, tables: readonly string[]): Record<string, number> {
  return Object.fromEntries(
    tables.map((t) => [t, (db.$client.prepare(`SELECT count(*) AS n FROM "${t}"`).get() as { n: number }).n]),
  );
}

// ---------- staged uploads ----------

const stagedZip = (dataDir: string, id: string) => join(restoreDir(dataDir), `${id}.zip`);
const stagedInfo = (dataDir: string, id: string) => join(restoreDir(dataDir), `${id}.json`);

function removeStaged(dataDir: string, id: string): void {
  for (const file of [stagedZip(dataDir, id), stagedInfo(dataDir, id)]) rmSync(file, { force: true });
}

/** Removes every staged upload (expired ones only, unless `all`) and scratch databases. */
export function cleanStaged(dataDir: string, at: Date, all = false): void {
  const dir = restoreDir(dataDir);
  for (const name of readdirSync(dir)) {
    const match = /^([0-9a-f]{32})\.(zip|json|db|db-wal|db-shm)$/.exec(name);
    if (!match) continue;
    const id = match[1] as string;
    if (match[2]?.startsWith("db")) {
      rmSync(join(dir, name), { force: true });
      continue;
    }
    if (match[2] !== "json") continue;
    let expired = true;
    try {
      const info = JSON.parse(readFileSync(join(dir, name), "utf8")) as StagedInfo;
      expired = Date.parse(info.preview.expiresAt) <= at.getTime();
    } catch {
      // unreadable: treat as expired
    }
    if (all || expired) removeStaged(dataDir, id);
  }
  // Zips without their info file are leftovers of a crash during an upload.
  for (const name of readdirSync(dir)) {
    const match = /^([0-9a-f]{32})\.zip$/.exec(name);
    if (match && !existsSync(join(dir, `${match[1]}.json`))) rmSync(join(dir, name), { force: true });
  }
}

/** Checks an uploaded export zip and stages it (one at a time); 422 with problems when it cannot be restored. */
export function stageUpload(deps: RestoreDeps, name: string | undefined, zip: Buffer): RestorePreview {
  if (deps.restoreLock.busy) throw new ApiError("conflict", "A restore is running. Wait until it is done.");
  const at = deps.clock();
  cleanStaged(deps.dataDir, at, true);
  const uploadId = randomBytes(16).toString("hex");
  const problems = new Problems();
  if (zip.length === 0) problems.add("The file is empty.");
  const archive = problems.any ? null : readArchive(zip, deps.limits, schemaVersion(deps.db), problems);
  if (!archive) throw problems.error();
  checkTables(deps.db, archive, problems);
  if (!problems.any) trialImport(deps.dataDir, uploadId, archive, problems);
  const attachments = problems.any ? null : checkAttachments(archive, problems);
  if (problems.any || !attachments) throw problems.error();

  const tables = FORMAT_TABLES[archive.manifest.format] ?? [];
  const preview: RestorePreview = {
    uploadId,
    fileName: (name ?? "").split(/[/\\]/).pop()?.slice(0, 200) || "export.zip",
    format: archive.manifest.format,
    exportedAt: new Date(archive.manifest.exportedAt).toISOString(),
    appVersion: archive.manifest.appVersion,
    schemaVersion: archive.manifest.schemaVersion,
    inFile: Object.fromEntries(tables.map((t) => [t, archive.data[t]?.length ?? 0])),
    now: liveCounts(deps.db, tables),
    attachments: { count: attachments.count, bytes: attachments.bytes, missing: attachments.missing },
    warnings: attachments.warnings,
    expiresAt: new Date(at.getTime() + STAGE_TTL_MS).toISOString(),
  };
  const zipFile = stagedZip(deps.dataDir, uploadId);
  const fd = openSync(zipFile, "w", 0o600);
  try {
    writeSync(fd, zip);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  writePrivateFile(stagedInfo(deps.dataDir, uploadId), JSON.stringify({ preview } satisfies StagedInfo));
  return preview;
}

/** The preview of a staged upload; 404 when unknown or expired (an expired one is removed). */
export function getStaged(deps: RestoreDeps, uploadId: string): RestorePreview {
  let info: StagedInfo;
  try {
    info = JSON.parse(readFileSync(stagedInfo(deps.dataDir, uploadId), "utf8")) as StagedInfo;
  } catch {
    throw new ApiError("not_found", "This upload does not exist (anymore). Upload the file again.");
  }
  if (
    Date.parse(info.preview.expiresAt) <= deps.clock().getTime() ||
    !existsSync(stagedZip(deps.dataDir, uploadId))
  ) {
    removeStaged(deps.dataDir, uploadId);
    throw new ApiError("not_found", "This upload has expired. Upload the file again.");
  }
  return info.preview;
}

export function discardStaged(deps: RestoreDeps, uploadId: string): void {
  getStaged(deps, uploadId);
  removeStaged(deps.dataDir, uploadId);
}

// ---------- safety copies ----------

function newestBackupFirst(a: string, b: string): number {
  const [, stampA = "", nA = "1"] = BACKUP_FILE.exec(a) ?? [];
  const [, stampB = "", nB = "1"] = BACKUP_FILE.exec(b) ?? [];
  return stampB.localeCompare(stampA) || Number(nB) - Number(nA);
}

export function listBackups(dataDir: string): BackupFile[] {
  const dir = backupsDir(dataDir);
  return readdirSync(dir)
    .filter((name) => BACKUP_FILE.test(name))
    .toSorted(newestBackupFirst)
    .map((fileName) => {
      const stat = statSync(join(dir, fileName));
      return { fileName, createdAt: stat.mtime.toISOString(), bytes: stat.size };
    });
}

/** Path of a safety copy by its exact file name; 404 for anything else. */
export function backupPath(dataDir: string, fileName: string): string {
  const path = join(backupsDir(dataDir), fileName);
  if (!BACKUP_FILE.test(fileName) || !existsSync(path)) {
    throw new ApiError("not_found", `There is no safety copy named ${fileName}.`);
  }
  return path;
}

/** An export of the current data into <data dir>/backups (lastExportAt untouched), newest 5 kept. */
async function writeSafetyCopy(deps: RestoreDeps): Promise<BackupFile> {
  const dir = backupsDir(deps.dataDir);
  const at = deps.clock();
  const { stream } = buildExport(deps, {
    attachmentsDir: deps.attachmentsDir,
    appVersion: deps.version,
    recordExport: false,
  });
  const fileName = freeName(dir, `organizer-before-restore-${fileStamp(at, deps.timeZone)}.zip`);
  const bytes = await writeFileAtomically(stream, join(dir, fileName));
  for (const old of listBackups(deps.dataDir).slice(BACKUPS_KEEP))
    rmSync(join(dir, old.fileName), { force: true });
  return { fileName, createdAt: at.toISOString(), bytes };
}

// ---------- apply ----------

interface InProgress {
  uploadId: string;
  stagingDir: string;
}

/** Step 4 of a restore: the staged files become the attachments folder. Safe to run again after a crash. */
function swapAttachments(dataDir: string, db: Db, progress: InProgress): void {
  const live = join(dataDir, ATTACHMENTS_DIR);
  const old = oldDir(dataDir, progress.uploadId);
  if (existsSync(progress.stagingDir)) {
    if (existsSync(live)) {
      rmSync(old, { recursive: true, force: true });
      renameSync(live, old);
    }
    renameSync(progress.stagingDir, live);
  }
  rmSync(old, { recursive: true, force: true });
  db.$client.prepare("DELETE FROM settings WHERE key = ?").run(RESTORE_IN_PROGRESS);
}

/** Writes each checked file to <dir>/<id> (0600, synced). */
function folderSink(dir: string): FileSink {
  let fd: number | null = null;
  return {
    start(id) {
      fd = openSync(join(dir, String(id)), "w", 0o600);
    },
    write(chunk) {
      if (fd !== null) writeSync(fd, chunk);
    },
    end() {
      if (fd === null) return;
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
    },
  };
}

/**
 * Replaces all data with the staged export: (1) a safety copy of the current data, (2) the files
 * into a staging folder (checked again), (3) one transaction for the rows, sequences, name keys,
 * scope repair, search index and the restoreInProgress marker, (4) the folder swap, (5) the staged upload goes.
 * Tokens, the secret and device settings are not touched.
 */
export async function applyRestore(deps: RestoreDeps, uploadId: string): Promise<RestoreResult> {
  if (deps.restoreLock.busy) throw new ApiError("conflict", "A restore is running. Wait until it is done.");
  getStaged(deps, uploadId);
  deps.restoreLock.busy = true;
  const staging = stagingDir(deps.dataDir, uploadId);
  try {
    const problems = new Problems();
    const archive = readArchive(
      readFileSync(stagedZip(deps.dataDir, uploadId)),
      deps.limits,
      schemaVersion(deps.db),
      problems,
    );
    if (!archive) throw problems.error();

    const safetyCopy = await writeSafetyCopy(deps);

    rmSync(staging, { recursive: true, force: true });
    privateDir(staging);
    // The files are checked again (size and sha256) while they are written.
    checkAttachments(archive, problems, folderSink(staging));
    if (problems.any) throw problems.error();

    const sqlite = deps.db.$client;
    const progress: InProgress = { uploadId, stagingDir: staging };
    sqlite.transaction(() => {
      replaceAllData(sqlite, archive.data, archive.manifest.sequences);
      repairNameKeys(sqlite);
      repairScopeConflicts(deps);
      rebuildSearchIndex(deps.db);
      const broken = sqlite.pragma("foreign_key_check") as unknown[];
      if (broken.length > 0)
        throw new ApiError(
          "validation_failed",
          "The restored data has broken references. Nothing was changed.",
        );
      setSetting(deps.db, RESTORE_IN_PROGRESS, progress);
    })();

    swapAttachments(deps.dataDir, deps.db, progress);
    removeStaged(deps.dataDir, uploadId);
    const tables = FORMAT_TABLES[archive.manifest.format] ?? [];
    return {
      restoredAt: now(deps),
      counts: Object.fromEntries(tables.map((t) => [t, archive.data[t]?.length ?? 0])),
      safetyCopy,
    };
  } catch (error) {
    if (!getSetting<InProgress>(deps.db, RESTORE_IN_PROGRESS))
      rmSync(staging, { recursive: true, force: true });
    throw error;
  } finally {
    deps.restoreLock.busy = false;
  }
}

/**
 * Start-up recovery, before anything uses the attachments folder: a restore that committed but did
 * not finish the folder swap is finished; otherwise leftover staging folders and expired uploads go.
 */
export function recoverRestore(dataDir: string, db: Db, at: Date): "finished" | "clean" {
  const progress = getSetting<InProgress>(db, RESTORE_IN_PROGRESS);
  if (progress) {
    swapAttachments(dataDir, db, progress);
    return "finished";
  }
  for (const name of readdirSync(dataDir)) {
    if (name.startsWith(`${ATTACHMENTS_DIR}.restore-`))
      rmSync(join(dataDir, name), { recursive: true, force: true });
  }
  if (existsSync(join(dataDir, RESTORE_DIR))) cleanStaged(dataDir, at);
  return "clean";
}
