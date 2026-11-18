import type { BackupFile, RestorePreview, RestoreResult } from "@organizer/shared";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { writePrivateFile } from "../data-dir.ts";
import { type Db, openDb, schemaVersion } from "../db/index.ts";
import { ApiError } from "../http/errors.ts";
import { detectType, OCTET_STREAM, sanitizeName } from "./attachments.ts";
import { type Ctx, now, type Scoped } from "./context.ts";
import {
  attachmentFileName,
  buildExport,
  dbTable,
  EXPORT_FORMAT,
  EXPORT_TABLES,
  fileStamp,
} from "./export.ts";
import { freeName, privateDir, writeFileAtomically } from "./files.ts";
import { linkCommentAuthors } from "./comments.ts";
import { repairScopeConflicts } from "./labels.ts";
import { repairNameKeys } from "./name-keys.ts";
import {
  type ExportData,
  replaceAccountData,
  RowError,
  type Sequences,
  tableColumns,
} from "./restore-data.ts";
import { rebuildAccountIndex } from "./search-index.ts";
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
/** Safety copies kept per account in <backups>/accounts/<account id>. */
export const BACKUPS_KEEP = 5;
export const RESTORE_IN_PROGRESS = "restoreInProgress";

const RESTORE_DIR = "restore";
const BACKUP_FILE = /^sloppanizer-before-restore-(\d{8}-\d{6})(?:-(\d+))?\.zip$/;
const MAX_PROBLEMS = 20;
const BUSY = "The server is busy with another restore. Try again in a few minutes.";
/** The account of the scratch database a trial import runs in. */
const SCRATCH_ACCOUNT = 1;

const MEETING_TABLES: ReadonlySet<string> = new Set([
  "meetings",
  "series",
  "series_exceptions",
  "meeting_notes",
  "standup_marks",
]);

/** Tables of each export format. Formats 1 to 3 come from the single-user organizer, 4 on from Sloppanizer. */
const FORMAT_TABLES: Record<number, readonly string[]> = {
  1: ["projects", "labels", "people", "todos", "todo_labels", "todo_people", "events", "settings"],
  2: EXPORT_TABLES.filter((t) => !["todo_links", "todo_urls", "time_blocks"].includes(t)),
  // Format 3 adds todo_links (and manifest.sequences).
  3: EXPORT_TABLES.filter((t) => t !== "todo_urls" && t !== "time_blocks"),
  // Format 4: one account, sequences of every id table, the account in the manifest.
  4: EXPORT_TABLES.filter((t) => t !== "todo_urls" && t !== "time_blocks"),
  // Format 5 adds web links of todos and the planner's time blocks.
  5: EXPORT_TABLES.filter((t) => !MEETING_TABLES.has(t)),
  // Format 6 adds meetings: their repeat, single date changes, note links and standup marks.
  6: EXPORT_TABLES,
};
/** The app that writes each format. */
const FORMAT_APP: Record<number, "organizer" | "sloppanizer"> = {
  1: "organizer",
  2: "organizer",
  3: "organizer",
  4: "sloppanizer",
  5: "sloppanizer",
  6: "sloppanizer",
};

/** What a restore needs from the server, besides the account's context. */
export interface RestoreEnv {
  version: string;
  /** Staged uploads and scratch databases live in <data dir>/restore. */
  dataDir: string;
  /** Attachments, one folder per account. */
  filesDir: string;
  /** Safety copies go to <backups>/accounts/<account id>. */
  backupDir: string;
  filesLimitBytes: number;
  limits: RestoreLimits;
  /** One restore at a time on the server. */
  restoreLock: { busy: boolean };
}

/** The caller's account (its rows, files and safety copies are the only ones a restore touches). */
export type RestoreCtx = Ctx & RestoreEnv & { account: { username: string; displayName: string } };

interface Manifest {
  app: "organizer" | "sloppanizer";
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
  mime_type: string;
}

/** Bytes detectType needs from the start of a file. */
const HEAD_BYTES = 16;

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

const restoreDir = (dataDir: string) => privateDir(join(dataDir, RESTORE_DIR));
const backupsDir = (env: Pick<RestoreEnv, "backupDir">, accountId: number) =>
  privateDir(join(env.backupDir, "accounts", String(accountId)));
/** The live files folder of an account and the folders a restore swaps it with (same file system). */
const liveDir = (filesDir: string, accountId: number) => join(filesDir, String(accountId));
const stagingDir = (filesDir: string, accountId: number, uploadId: string) =>
  join(filesDir, `.restore-${accountId}-${uploadId}`);
const oldDir = (filesDir: string, accountId: number, uploadId: string) =>
  join(filesDir, `.old-${accountId}-${uploadId}`);

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
  if (!manifestEntry) problems.add("manifest.json is missing. Is this a Sloppanizer export?");
  if (!dataEntry) problems.add("data.json is missing. Is this a Sloppanizer export?");
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
  if (!isRecord(manifest) || (manifest.app !== "sloppanizer" && manifest.app !== "organizer")) {
    problems.add(
      'manifest.json does not say app "sloppanizer" or "organizer". Is this a Sloppanizer export?',
    );
    return null;
  }
  if (FORMAT_APP[manifest.format] !== manifest.app) {
    problems.add(
      `Export format ${String(manifest.format)} of app "${manifest.app}" is not known. Formats 1 to 3 (organizer) and 4 to ${EXPORT_FORMAT} (Sloppanizer) can be restored.`,
    );
    return null;
  }
  if (typeof manifest.schemaVersion !== "number" || manifest.schemaVersion > currentSchema) {
    problems.add(
      "This export comes from a newer Sloppanizer. It can be restored once the server is updated.",
    );
    return null;
  }
  if (manifest.sequences !== undefined && !isRecord(manifest.sequences)) {
    problems.add("manifest.json has sequences that are not a table of numbers.");
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
      (
        db.$client.prepare(`PRAGMA table_info("${dbTable(table)}")`).all() as { name: string; type: string }[]
      ).map((c) => [c.name, c.type]),
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

/**
 * Loads the data into a scratch database with one scratch account, so FK, CHECK and UNIQUE problems show
 * with table and id before the real account is touched.
 */
function trialImport(file: string, archive: Archive, problems: Problems): void {
  const scratch = openDb(file);
  const sqlite = scratch.$client;
  const rollback = new Error("rollback");
  try {
    sqlite.transaction(() => {
      const at = new Date(0).toISOString();
      sqlite
        .prepare(
          `INSERT INTO accounts (id, username, display_name, time_zone, status, webauthn_user_id, created_at, updated_at)
           VALUES (?, 'scratch', 'Scratch', 'UTC', 'active', 'scratch', ?, ?)`,
        )
        .run(SCRATCH_ACCOUNT, at, at);
      try {
        replaceAccountData(sqlite, SCRATCH_ACCOUNT, archive.data, archive.manifest.sequences);
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
  /** The first bytes of every checked file by attachment id (for the type). */
  heads: Map<number, Buffer>;
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
  const heads = new Map<number, Buffer>();
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
    // Refused before unpacking: data.json and the zip directory must agree on the size.
    if (entry.size !== row.size) {
      problems.add(
        `The file of attachment ${row.id} (${row.name}) has ${entry.size} bytes in the archive, but data.json says ${String(row.size)}.`,
      );
      continue;
    }
    const hash = createHash("sha256");
    let head = Buffer.alloc(0);
    let size: number;
    sink?.start(row.id);
    try {
      size = inflateEntry(archive.zip, entry, entry.size, (chunk) => {
        if (head.length < HEAD_BYTES)
          head = Buffer.concat([head, chunk.subarray(0, HEAD_BYTES - head.length)]);
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
    heads.set(row.id, head);
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
  return { count, bytes, missing, warnings, heads };
}

/**
 * Type and name of restored attachments are never taken from data.json: the type comes from the
 * file's first bytes and the name is cleaned, as for an upload (a file missing in the archive gets
 * application/octet-stream). Otherwise a crafted export could serve a file as text/html.
 */
function cleanAttachmentRows(archive: Archive, heads: ReadonlyMap<number, Buffer>): void {
  for (const row of (archive.data.attachments ?? []) as unknown as AttachmentRowData[]) {
    const head = heads.get(row.id);
    const { mime, ext } = head ? detectType(head) : { mime: OCTET_STREAM, ext: "" };
    row.mime_type = mime;
    row.name = sanitizeName(typeof row.name === "string" ? row.name : undefined, ext);
  }
}

/** Rows of the account per data.json table. */
function liveCounts(sc: Pick<Ctx, "db" | "accountId">, tables: readonly string[]): Record<string, number> {
  return Object.fromEntries(
    tables.map((t) => [
      t,
      (
        sc.db.$client
          .prepare(`SELECT count(*) AS n FROM "${dbTable(t)}" WHERE account_id = ?`)
          .get(sc.accountId) as { n: number }
      ).n,
    ]),
  );
}

const GIB = 1024 ** 3;
const sizeText = (bytes: number): string =>
  bytes >= GIB ? `${(bytes / GIB).toFixed(1).replace(/\.0$/, "")} GB` : `${Math.ceil(bytes / MiB)} MB`;

// ---------- staged uploads (per account: <data dir>/restore/<account id>-<upload id>.*) ----------

const stageKey = (accountId: number, uploadId: string) => `${accountId}-${uploadId}`;
const stagedZip = (dataDir: string, key: string) => join(restoreDir(dataDir), `${key}.zip`);
const stagedInfo = (dataDir: string, key: string) => join(restoreDir(dataDir), `${key}.json`);

function removeStaged(dataDir: string, key: string): void {
  for (const file of [stagedZip(dataDir, key), stagedInfo(dataDir, key)]) rmSync(file, { force: true });
}

const STAGED_FILE = /^(\d+)-([0-9a-f]{32})\.(zip|json|db|db-wal|db-shm)$/;

/**
 * Removes expired staged uploads of every account (and all of `dropAccount`'s, when given) and scratch
 * databases. Zips without their info file are leftovers of a crash during an upload.
 */
export function cleanStaged(dataDir: string, at: Date, dropAccount?: number): void {
  const dir = restoreDir(dataDir);
  for (const name of readdirSync(dir)) {
    const match = STAGED_FILE.exec(name);
    if (!match) continue;
    const key = `${match[1]}-${match[2]}`;
    if (match[3]?.startsWith("db")) {
      rmSync(join(dir, name), { force: true });
      continue;
    }
    if (match[3] !== "json") continue;
    let expired = true;
    try {
      const info = JSON.parse(readFileSync(join(dir, name), "utf8")) as StagedInfo;
      expired = Date.parse(info.preview.expiresAt) <= at.getTime();
    } catch {
      // unreadable: treat as expired
    }
    if (expired || Number(match[1]) === dropAccount) removeStaged(dataDir, key);
  }
  for (const name of readdirSync(dir)) {
    const match = STAGED_FILE.exec(name);
    if (match?.[3] === "zip" && !existsSync(join(dir, `${match[1]}-${match[2]}.json`)))
      rmSync(join(dir, name), { force: true });
  }
}

/**
 * Checks an uploaded export zip and stages it for the account (one upload per account; another one
 * replaces it); 422 with problems when it cannot be restored, also when its files pass the account's limit.
 */
export function stageUpload(ctx: RestoreCtx, name: string | undefined, zip: Buffer): RestorePreview {
  if (ctx.restoreLock.busy) throw new ApiError("conflict", BUSY);
  const at = ctx.clock();
  cleanStaged(ctx.dataDir, at, ctx.accountId);
  const uploadId = randomBytes(16).toString("hex");
  const key = stageKey(ctx.accountId, uploadId);
  const problems = new Problems();
  if (zip.length === 0) problems.add("The file is empty.");
  const archive = problems.any ? null : readArchive(zip, ctx.limits, schemaVersion(ctx.db), problems);
  if (!archive) throw problems.error();
  checkTables(ctx.db, archive, problems);
  if (!problems.any) trialImport(join(restoreDir(ctx.dataDir), `${key}.db`), archive, problems);
  const attachments = problems.any ? null : checkAttachments(archive, problems);
  if (attachments && attachments.bytes > ctx.filesLimitBytes) {
    problems.add(
      `The files in this export use ${sizeText(attachments.bytes)}, more than this account's limit of ${sizeText(ctx.filesLimitBytes)}. Ask the admin.`,
    );
  }
  if (problems.any || !attachments) throw problems.error();

  const tables = FORMAT_TABLES[archive.manifest.format] ?? [];
  const preview: RestorePreview = {
    uploadId,
    fileName: (name ?? "").split(/[/\\]/).pop()?.slice(0, 200) || "export.zip",
    source: archive.manifest.app,
    format: archive.manifest.format,
    exportedAt: new Date(archive.manifest.exportedAt).toISOString(),
    appVersion: archive.manifest.appVersion,
    schemaVersion: archive.manifest.schemaVersion,
    inFile: Object.fromEntries(tables.map((t) => [t, archive.data[t]?.length ?? 0])),
    now: liveCounts(ctx, tables),
    attachments: { count: attachments.count, bytes: attachments.bytes, missing: attachments.missing },
    warnings: attachments.warnings,
    expiresAt: new Date(at.getTime() + STAGE_TTL_MS).toISOString(),
  };
  const zipFile = stagedZip(ctx.dataDir, key);
  const fd = openSync(zipFile, "w", 0o600);
  try {
    writeSync(fd, zip);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  writePrivateFile(stagedInfo(ctx.dataDir, key), JSON.stringify({ preview } satisfies StagedInfo));
  return preview;
}

type StagedCtx = Pick<RestoreCtx, "dataDir" | "clock" | "accountId">;

/**
 * The preview of the account's staged upload; 404 when unknown, expired (an expired one is removed) or
 * another account's.
 */
export function getStaged(ctx: StagedCtx, uploadId: string): RestorePreview {
  const key = stageKey(ctx.accountId, uploadId);
  let info: StagedInfo;
  try {
    info = JSON.parse(readFileSync(stagedInfo(ctx.dataDir, key), "utf8")) as StagedInfo;
  } catch {
    throw new ApiError("not_found", "This upload does not exist (anymore). Upload the file again.");
  }
  if (
    Date.parse(info.preview.expiresAt) <= ctx.clock().getTime() ||
    !existsSync(stagedZip(ctx.dataDir, key))
  ) {
    removeStaged(ctx.dataDir, key);
    throw new ApiError("not_found", "This upload has expired. Upload the file again.");
  }
  return info.preview;
}

export function discardStaged(ctx: StagedCtx, uploadId: string): void {
  getStaged(ctx, uploadId);
  removeStaged(ctx.dataDir, stageKey(ctx.accountId, uploadId));
}

// ---------- safety copies ----------

function newestBackupFirst(a: string, b: string): number {
  const [, stampA = "", nA = "1"] = BACKUP_FILE.exec(a) ?? [];
  const [, stampB = "", nB = "1"] = BACKUP_FILE.exec(b) ?? [];
  return stampB.localeCompare(stampA) || Number(nB) - Number(nA);
}

/** The account's safety copies, newest first. */
export function listBackups(env: Pick<RestoreEnv, "backupDir">, accountId: number): BackupFile[] {
  const dir = backupsDir(env, accountId);
  return readdirSync(dir)
    .filter((name) => BACKUP_FILE.test(name))
    .toSorted(newestBackupFirst)
    .map((fileName) => {
      const stat = statSync(join(dir, fileName));
      return { fileName, createdAt: stat.mtime.toISOString(), bytes: stat.size };
    });
}

/** Path of one of the account's safety copies by its exact file name; 404 for anything else. */
export function backupPath(env: Pick<RestoreEnv, "backupDir">, accountId: number, fileName: string): string {
  const path = join(backupsDir(env, accountId), fileName);
  if (!BACKUP_FILE.test(fileName) || !existsSync(path)) {
    throw new ApiError("not_found", `There is no safety copy named ${fileName}.`);
  }
  return path;
}

/** An export of the account's current data into its backups folder (lastExportAt untouched), newest 5 kept. */
async function writeSafetyCopy(ctx: RestoreCtx): Promise<BackupFile> {
  const dir = backupsDir(ctx, ctx.accountId);
  const at = ctx.clock();
  const { stream } = buildExport(ctx, {
    filesDir: liveDir(ctx.filesDir, ctx.accountId),
    appVersion: ctx.version,
    account: ctx.account,
    recordExport: false,
  });
  const fileName = freeName(dir, `sloppanizer-before-restore-${fileStamp(at, ctx.timeZone)}.zip`);
  const bytes = await writeFileAtomically(stream, join(dir, fileName));
  for (const old of listBackups(ctx, ctx.accountId).slice(BACKUPS_KEEP))
    rmSync(join(dir, old.fileName), { force: true });
  return { fileName, createdAt: at.toISOString(), bytes };
}

// ---------- apply ----------

interface InProgress {
  uploadId: string;
}

/**
 * Step 4 of a restore: the staged files become the account's files folder. Safe to run again after a
 * crash.
 */
function swapFiles(filesDir: string, db: Db, accountId: number, progress: InProgress): void {
  const live = liveDir(filesDir, accountId);
  const staging = stagingDir(filesDir, accountId, progress.uploadId);
  const old = oldDir(filesDir, accountId, progress.uploadId);
  if (existsSync(staging)) {
    if (existsSync(live)) {
      rmSync(old, { recursive: true, force: true });
      renameSync(live, old);
    }
    renameSync(staging, live);
  }
  rmSync(old, { recursive: true, force: true });
  db.$client
    .prepare("DELETE FROM account_settings WHERE account_id = ? AND key = ?")
    .run(accountId, RESTORE_IN_PROGRESS);
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
 * Replaces the account's data with its staged export: (1) a safety copy of its current data, (2) the
 * files into a staging folder (checked again), (3) one transaction for its rows, sequences, name keys,
 * scope repair, search index and the restoreInProgress marker, (4) the folder swap, (5) the staged
 * upload goes. Other accounts, the account's sign-in data and its tokens are not touched.
 */
export async function applyRestore(ctx: RestoreCtx, uploadId: string): Promise<RestoreResult> {
  if (ctx.restoreLock.busy) throw new ApiError("conflict", BUSY);
  getStaged(ctx, uploadId);
  ctx.restoreLock.busy = true;
  const key = stageKey(ctx.accountId, uploadId);
  const staging = stagingDir(ctx.filesDir, ctx.accountId, uploadId);
  const sc: Scoped = ctx;
  try {
    const problems = new Problems();
    const archive = readArchive(
      readFileSync(stagedZip(ctx.dataDir, key)),
      ctx.limits,
      schemaVersion(ctx.db),
      problems,
    );
    if (!archive) throw problems.error();

    const safetyCopy = await writeSafetyCopy(ctx);

    rmSync(staging, { recursive: true, force: true });
    privateDir(staging);
    // The files are checked again (size and sha256) while they are written.
    const { heads } = checkAttachments(archive, problems, folderSink(staging));
    if (problems.any) throw problems.error();
    cleanAttachmentRows(archive, heads);

    const sqlite = ctx.db.$client;
    const progress: InProgress = { uploadId };
    sqlite.transaction(() => {
      replaceAccountData(sqlite, ctx.accountId, archive.data, archive.manifest.sequences);
      repairNameKeys(sqlite, ctx.accountId);
      linkCommentAuthors(sqlite, ctx.accountId);
      repairScopeConflicts(ctx);
      rebuildAccountIndex(sc);
      const broken = sqlite.pragma("foreign_key_check") as unknown[];
      if (broken.length > 0)
        throw new ApiError(
          "validation_failed",
          "The restored data has broken references. Nothing was changed.",
        );
      setSetting(sc, RESTORE_IN_PROGRESS, progress);
    })();

    swapFiles(ctx.filesDir, ctx.db, ctx.accountId, progress);
    removeStaged(ctx.dataDir, key);
    const tables = FORMAT_TABLES[archive.manifest.format] ?? [];
    return {
      restoredAt: now(ctx),
      counts: Object.fromEntries(tables.map((t) => [t, archive.data[t]?.length ?? 0])),
      safetyCopy,
    };
  } catch (error) {
    if (!getSetting<InProgress>(sc, RESTORE_IN_PROGRESS)) rmSync(staging, { recursive: true, force: true });
    throw error;
  } finally {
    ctx.restoreLock.busy = false;
  }
}

/**
 * Start-up recovery, before anything uses the files folders: restores that committed but did not finish
 * the folder swap are finished (any account); otherwise leftover staging folders and expired uploads go.
 * Returns how many restores it finished.
 */
export function recoverRestore(env: Pick<RestoreEnv, "dataDir" | "filesDir">, db: Db, at: Date): number {
  const pending = db.$client
    .prepare("SELECT account_id AS accountId, value FROM account_settings WHERE key = ?")
    .all(RESTORE_IN_PROGRESS) as { accountId: number; value: string }[];
  for (const { accountId, value } of pending) {
    swapFiles(env.filesDir, db, accountId, JSON.parse(value) as InProgress);
  }
  if (existsSync(env.filesDir)) {
    for (const name of readdirSync(env.filesDir)) {
      if (name.startsWith(".restore-") || name.startsWith(".old-"))
        rmSync(join(env.filesDir, name), { recursive: true, force: true });
    }
  }
  if (existsSync(join(env.dataDir, RESTORE_DIR))) cleanStaged(env.dataDir, at);
  return pending.length;
}
