import {
  addDays,
  type InstanceBackup,
  localTimeToInstant,
  SCHEMA_BASE,
  toLocalDate,
} from "@organizer/shared";
import Database from "better-sqlite3";
import { count } from "drizzle-orm";
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
} from "node:fs";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Clock } from "../clock.ts";
import { accounts } from "../db/auth-schema.ts";
import { type Db, MIGRATIONS_DIR, schemaVersion } from "../db/index.ts";
import { ApiError } from "../http/errors.ts";
import { randomHex } from "./auth/crypto.ts";
import { logAdminEvent, setInstanceSetting } from "./auth/instance.ts";
import { fileStamp } from "./export.ts";
import { type ZipEntry, zipStream } from "./zip-writer.ts";

/**
 * Whole-instance backups. They stay on the server (inside the backups volume): the admin dashboard
 * shows time, size and count only, never a download, so no admin can read other accounts' data through
 * the app. The README says how to copy one off the server and restore it.
 *
 * A backup is one zip `<backups>/instance/sloppanizer-backup-YYYYMMDD-HHmmss.zip`: manifest.json, the
 * database (SQLite online backup, consistent while the server runs) and `files/<account>/<id>`, stored
 * without compression. Written as .partial, synced, then renamed, so a half-written zip never counts.
 */

export const INSTANCE_DIR = "instance";
const BACKUP_PATTERN = /^sloppanizer-backup-\d{8}-\d{6}\.zip$/;
const PRE_MIGRATE_PATTERN = /^pre-migrate-\d+-\d{8}-\d{6}\.db$/;
const PRE_MIGRATE_KEEP = 3;
/** Zip without zip64: stay clearly below 4 GiB. Bigger instances are copied as volumes (README). */
export const MAX_BACKUP_BYTES = 4 * 1024 ** 3 - 64 * 1024 ** 2;

export interface BackupOptions {
  db: Db;
  clock: Clock;
  backupDir: string;
  filesDir: string;
  keep: number;
  version: string;
  timeZone: string;
  /** Who started it (admin username, "cli" or "system"), for the admin log. */
  actor: string;
}

const instanceDir = (backupDir: string): string => {
  const dir = join(backupDir, INSTANCE_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
};

/** Newest first. */
export function listBackups(backupDir: string): InstanceBackup[] {
  const dir = join(backupDir, INSTANCE_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => BACKUP_PATTERN.test(name))
    .map((fileName) => {
      const stat = statSync(join(dir, fileName));
      return { fileName, createdAt: stat.mtime.toISOString(), bytes: stat.size };
    })
    .toSorted((a, b) => b.fileName.localeCompare(a.fileName));
}

/** Deletes all but the newest `keep` files matching the pattern (names sort by time). */
function prune(dir: string, pattern: RegExp, keep: number): void {
  const names = readdirSync(dir)
    .filter((name) => pattern.test(name))
    .toSorted()
    .toReversed();
  for (const name of names.slice(keep)) rmSync(join(dir, name), { force: true });
}

let running = false;

/** Makes one backup (one at a time) and keeps the newest `keep`. */
export async function createInstanceBackup(options: BackupOptions): Promise<InstanceBackup> {
  if (running) throw new ApiError("conflict", "A backup is running already. Try again in a few minutes.");
  running = true;
  const dir = instanceDir(options.backupDir);
  const tmpDb = join(dir, `.tmp-${randomHex(8)}.db`);
  const now = options.clock();
  const fileName = `sloppanizer-backup-${fileStamp(now, options.timeZone)}.zip`;
  const partial = join(dir, `${fileName}.partial`);
  try {
    await options.db.$client.backup(tmpDb);
    const entries: ZipEntry[] = [];
    let bytes = statSync(tmpDb).size;
    let files = 0;
    let missing = 0;
    const rows = options.db.$client
      .prepare("SELECT account_id AS accountId, id FROM attachments ORDER BY account_id, id")
      .all() as { accountId: number; id: number }[];
    for (const row of rows) {
      const file = join(options.filesDir, String(row.accountId), String(row.id));
      if (!existsSync(file)) {
        missing++;
        continue;
      }
      bytes += statSync(file).size;
      files++;
      entries.push({ path: `files/${row.accountId}/${row.id}`, stored: true, file });
    }
    if (bytes > MAX_BACKUP_BYTES) {
      throw new ApiError(
        "conflict",
        "The instance is too large for one backup zip (4 GB). Copy the Docker volumes instead (see the README).",
      );
    }
    const accountCount = options.db.select({ n: count() }).from(accounts).get()?.n ?? 0;
    const manifest = {
      app: "sloppanizer",
      kind: "instance",
      createdAt: now.toISOString(),
      appVersion: options.version,
      schemaVersion: schemaVersion(options.db),
      accounts: accountCount,
      files: { count: files, missing },
    };
    entries.unshift(
      {
        path: "manifest.json",
        stored: false,
        content: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
      },
      { path: "sloppanizer.db", stored: true, file: tmpDb },
    );
    await pipeline(zipStream(entries, now), createWriteStream(partial, { mode: 0o600 }));
    const fd = openSync(partial, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(partial, join(dir, fileName));
    prune(dir, BACKUP_PATTERN, options.keep);
    const result = { fileName, createdAt: now.toISOString(), bytes: statSync(join(dir, fileName)).size };
    options.db.transaction((tx) => {
      setInstanceSetting(tx, "lastBackup", { at: result.createdAt, fileName, bytes: result.bytes });
      logAdminEvent(tx, result.createdAt, options.actor, "backup", null, { fileName, bytes: result.bytes });
    });
    return result;
  } finally {
    rmSync(tmpDb, { force: true });
    rmSync(partial, { force: true });
    running = false;
  }
}

/** The next daily run after `nowMs` ("HH:MM" in the zone), or null when the schedule is off. */
export function nextBackupAt(nowMs: number, backupAt: string | null, timeZone: string): Date | null {
  if (backupAt === null) return null;
  const today = toLocalDate(nowMs, timeZone);
  for (const date of [today, addDays(today, 1), addDays(today, 2)]) {
    // The wall-clock time of that day, so DST days run at the same local time too.
    const at = localTimeToInstant(date, backupAt, timeZone);
    if (at.getTime() > nowMs) return at;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Copy before a migration

/** How many migrations the code ships (drizzle's journal). */
function shippedMigrations(): number {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")) as {
    entries: unknown[];
  };
  return journal.entries.length;
}

/**
 * Before the server applies a new migration to an existing database, it copies the database to
 * `<backups>/instance/pre-migrate-<schemaVersion>-<ts>.db` (newest 3), so a bad update can be undone by
 * putting the old image back with this file. Returns the copy's path, or null when nothing is pending
 * (or the database is new). Call it before openDb.
 */
export function backupBeforeMigrate(
  dbFile: string,
  backupDir: string,
  clock: Clock,
  timeZone = "UTC",
): string | null {
  if (!existsSync(dbFile)) return null;
  const sqlite = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    const table = sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
      .get();
    if (!table) return null;
    const applied = (sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number })
      .n;
    if (applied === 0 || applied >= shippedMigrations()) return null;
    const dir = instanceDir(backupDir);
    const target = join(dir, `pre-migrate-${SCHEMA_BASE + applied}-${fileStamp(clock(), timeZone)}.db`);
    sqlite.prepare("VACUUM INTO ?").run(target);
    chmodSync(target, 0o600);
    prune(dir, PRE_MIGRATE_PATTERN, PRE_MIGRATE_KEEP);
    return target;
  } finally {
    sqlite.close();
  }
}
