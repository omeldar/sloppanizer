import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli/admin.ts";
import { DB_FILE } from "../src/data-dir.ts";
import { accounts, adminEvents } from "../src/db/auth-schema.ts";
import { getInstanceSetting } from "../src/services/auth/instance.ts";
import {
  backupBeforeMigrate,
  type BackupOptions,
  createInstanceBackup,
  INSTANCE_DIR,
  listBackups,
  nextBackupAt,
} from "../src/services/instance-backup.ts";
import { readCentralDirectory, readEntry } from "../src/services/zip-reader.ts";
import { fillEveryTable } from "./fixtures.ts";
import { makeApp, type TestApp } from "./helpers.ts";

const MB = 1024 ** 2;

const backupOptions = (t: TestApp, extra: Partial<BackupOptions> = {}): BackupOptions => ({
  db: t.deps.db,
  clock: t.deps.clock,
  backupDir: t.config.backupDir,
  filesDir: t.config.filesDir,
  keep: 7,
  version: "9.9.9",
  timeZone: "UTC",
  actor: "system",
  ...extra,
});

const instanceDir = (t: TestApp) => join(t.config.backupDir, INSTANCE_DIR);

/** Opens a database file read-only, runs the check and closes it again. */
function withDb<T>(file: string, run: (db: Database.Database) => T): T {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

const todoTitles = (db: Database.Database) =>
  db.prepare("SELECT id, title FROM todos ORDER BY id").all() as unknown[];
const migrationCount = (db: Database.Database) =>
  (db.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n;
const fixedClock = () => new Date("2026-11-11T10:00:00.000Z");
const nextZurich = (now: string, at: string | null) =>
  nextBackupAt(Date.parse(now), at, "Europe/Zurich")?.toISOString() ?? null;

const integrity = (file: string) =>
  withDb(
    file,
    (db) => (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check,
  );

describe("instance backup", () => {
  it("zips the manifest, a consistent database and every attachment file", async () => {
    const t = await makeApp();
    await fillEveryTable(t);
    const backup = await createInstanceBackup(backupOptions(t));

    expect(backup.fileName).toBe("sloppanizer-backup-20261111-100000.zip");
    const zipFile = join(instanceDir(t), backup.fileName);
    const zip = readFileSync(zipFile);
    expect(backup.bytes).toBe(zip.length);
    const entries = readCentralDirectory(zip);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    const read = (name: string) => readEntry(zip, byName.get(name) as (typeof entries)[number], 64 * MB);

    const rows = t.deps.db.$client
      .prepare("SELECT account_id AS accountId, id FROM attachments ORDER BY id")
      .all() as { accountId: number; id: number }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(entries.map((entry) => entry.name)).toEqual([
      "manifest.json",
      "sloppanizer.db",
      ...rows.map((row) => `files/${row.accountId}/${row.id}`),
    ]);
    for (const row of rows) {
      expect(read(`files/${row.accountId}/${row.id}`)).toEqual(
        readFileSync(join(t.config.filesDir, String(row.accountId), String(row.id))),
      );
    }

    const manifest = JSON.parse(read("manifest.json").toString("utf8"));
    expect(manifest).toMatchObject({
      app: "sloppanizer",
      kind: "instance",
      createdAt: "2026-11-11T10:00:00.000Z",
      appVersion: "9.9.9",
      accounts: 1,
      files: { count: rows.length, missing: 0 },
    });

    const restored = join(mkdtempSync(join(tmpdir(), "sloppanizer-restore-")), "restored.db");
    try {
      writeFileSync(restored, read("sloppanizer.db"));
      expect(integrity(restored)).toBe("ok");
      expect(withDb(restored, todoTitles)).toEqual(todoTitles(t.deps.db.$client));
    } finally {
      rmSync(join(restored, ".."), { recursive: true, force: true });
    }

    // Nothing half-written is left behind, and the result is recorded for the dashboard and the log.
    expect(readdirSync(instanceDir(t))).toEqual([backup.fileName]);
    expect(statSync(zipFile).mode & 0o777).toBe(0o600);
    expect(statSync(instanceDir(t)).mode & 0o777).toBe(0o700);
    expect(getInstanceSetting(t.deps.db, "lastBackup")).toEqual({
      at: backup.createdAt,
      fileName: backup.fileName,
      bytes: backup.bytes,
    });
    const event = t.deps.db.select().from(adminEvents).where(eq(adminEvents.action, "backup")).get();
    expect(event).toMatchObject({ actor: "system" });
  });

  it("counts attachment files that are gone instead of failing", async () => {
    const t = await makeApp();
    const upload = await t.call("POST", "/api/v1/attachments?name=a.txt", Buffer.from("hello"), {
      "content-type": "text/plain",
    });
    expect(upload.statusCode).toBe(201);
    rmSync(join(t.filesDir, String(upload.json().id)));

    const backup = await createInstanceBackup(backupOptions(t));
    const zip = readFileSync(join(instanceDir(t), backup.fileName));
    const entries = readCentralDirectory(zip);
    expect(entries.map((entry) => entry.name)).toEqual(["manifest.json", "sloppanizer.db"]);
    const manifest = JSON.parse(readEntry(zip, entries[0] as (typeof entries)[number], MB).toString("utf8"));
    expect(manifest.files).toEqual({ count: 0, missing: 1 });
  });

  it("keeps only the newest N and lists them newest first", async () => {
    const t = await makeApp();
    const names: string[] = [];
    for (let i = 0; i < 4; i++) {
      // oxlint-disable-next-line no-await-in-loop -- one after the other, with the clock moving
      names.push((await createInstanceBackup(backupOptions(t, { keep: 2 }))).fileName);
      t.advance(1000);
    }
    expect(listBackups(t.config.backupDir).map((backup) => backup.fileName)).toEqual([names[3], names[2]]);
  });

  it("runs one backup at a time", async () => {
    const t = await makeApp();
    const results = await Promise.allSettled([
      createInstanceBackup(backupOptions(t)),
      createInstanceBackup(backupOptions(t)),
    ]);
    expect(results.map((result) => result.status).toSorted()).toEqual(["fulfilled", "rejected"]);
    // The lock is released afterwards.
    t.advance(1000);
    await expect(createInstanceBackup(backupOptions(t))).resolves.toMatchObject({
      bytes: expect.any(Number),
    });
  });
});

describe("backup schedule", () => {
  it("plans the next daily run in the instance's time zone", () => {
    // 02:00 in Zurich: today's 03:30 is still ahead.
    expect(nextZurich("2026-11-11T01:00:00.000Z", "03:30")).toBe("2026-11-11T02:30:00.000Z");
    // 11:00 in Zurich: tomorrow.
    expect(nextZurich("2026-11-11T10:00:00.000Z", "03:30")).toBe("2026-11-12T02:30:00.000Z");
    // Exactly at the time: the next day.
    expect(nextZurich("2026-11-11T02:30:00.000Z", "03:30")).toBe("2026-11-12T02:30:00.000Z");
  });

  it("follows daylight saving time and is off without a time", () => {
    // Summer time starts on 2026-03-29: 03:30 is then 01:30 UTC instead of 02:30.
    expect(nextZurich("2026-03-28T12:00:00.000Z", "03:30")).toBe("2026-03-29T01:30:00.000Z");
    // Summer time ends on 2026-10-25: 03:30 is then 02:30 UTC again.
    expect(nextZurich("2026-10-24T12:00:00.000Z", "03:30")).toBe("2026-10-25T02:30:00.000Z");
    expect(nextZurich("2026-11-11T10:00:00.000Z", null)).toBeNull();
  });
});

/** A stopped server's database with its newest migration marked as not applied yet. */
async function databaseBehindByOne() {
  const t = await makeApp();
  await fillEveryTable(t);
  await t.app.close();
  const dbFile = join(t.dataDir, DB_FILE);
  const db = new Database(dbFile);
  const applied = migrationCount(db);
  // drizzle's id column is "SERIAL", not a rowid alias in SQLite (it stays NULL): use the rowid.
  db.prepare(
    "DELETE FROM __drizzle_migrations WHERE rowid = (SELECT max(rowid) FROM __drizzle_migrations)",
  ).run();
  db.close();
  let now = Date.parse("2026-11-11T10:00:00.000Z");
  return {
    t,
    dbFile,
    applied,
    clock: () => new Date(now),
    tick: () => {
      now += 1000;
    },
  };
}

describe("copy before a migration", () => {
  it("copies the database when a migration is pending and keeps the newest 3", async () => {
    const { t, dbFile, applied, clock, tick } = await databaseBehindByOne();
    const copies: string[] = [];
    for (let i = 0; i < 4; i++) {
      const copy = backupBeforeMigrate(dbFile, t.config.backupDir, clock);
      expect(copy).not.toBeNull();
      copies.push(copy as string);
      tick();
    }
    expect(copies[0]).toMatch(/pre-migrate-\d+-20261111-100000\.db$/);
    const kept = readdirSync(instanceDir(t)).toSorted();
    expect(kept).toEqual(copies.slice(1).map((copy) => copy.split(/[\\/]/).pop()));

    const copy = copies[3] as string;
    expect(integrity(copy)).toBe("ok");
    expect(withDb(copy, migrationCount)).toBe(applied - 1);
    expect(withDb(copy, todoTitles)).toEqual(withDb(dbFile, todoTitles));
    expect(statSync(copy).mode & 0o777).toBe(0o600);
  });

  it("copies nothing when the database is up to date or new", async () => {
    const t = await makeApp();
    await t.app.close();
    expect(backupBeforeMigrate(join(t.dataDir, DB_FILE), t.config.backupDir, fixedClock)).toBeNull();
    expect(backupBeforeMigrate(join(t.dataDir, "missing.db"), t.config.backupDir, fixedClock)).toBeNull();
    expect(listBackups(t.config.backupDir)).toEqual([]);
  });
});

/** The admin CLI on a test instance's data dir, with its output captured. */
async function cli() {
  const t = await makeApp();
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void out.push(line));
  vi.spyOn(console, "error").mockImplementation((line: string) => void err.push(line));
  const env = { SLOPPANIZER_DATA_DIR: t.dataDir };
  const run = async (argv: string[], extraEnv: Record<string, string> = {}) => {
    out.length = 0;
    err.length = 0;
    return main(argv, { ...env, ...extraEnv }, t.deps.clock);
  };
  const row = (username: string) =>
    t.deps.db.select().from(accounts).where(eq(accounts.username, username)).get();
  const cliEvents = () =>
    t.deps.db
      .select()
      .from(adminEvents)
      .where(eq(adminEvents.actor, "cli"))
      .all()
      .map((event) => event.action);
  return { t, out, err, run, row, cliEvents };
}

describe("admin CLI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the usage for unknown commands and wrong arguments", async () => {
    const { run, err } = await cli();
    for (const argv of [[], ["nope"], ["unlock"], ["accounts", "anna"], ["disable", "anna", "now"]]) {
      // oxlint-disable-next-line no-await-in-loop -- the output is checked after each run
      expect(await run(argv)).toBe(2);
      expect(err.join("\n")).toContain("Usage:");
    }
  });

  it("lists accounts with metadata only", async () => {
    const { t, run, out } = await cli();
    await fillEveryTable(t);
    expect(await run(["accounts"])).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/^anna\s+active\s+user\s+last login/);
    for (const content of ["Rack", "Lab", "homelab", "Müller", "shot.png", "Prefers chat"]) {
      expect(text).not.toContain(content);
    }
  });

  it("disables (signing out every session), enables, unlocks and resets a login, by any spelling of the name", async () => {
    const { t, run, out, row, cliEvents } = await cli();
    expect(await run(["disable", "ANNA"])).toBe(0);
    expect(row("anna")?.status).toBe("disabled");
    expect(t.account.session()?.revokedAt).not.toBeNull();
    expect((await t.call("GET", "/api/v1/todos")).statusCode).toBe(401);

    expect(await run(["enable", "anna"])).toBe(0);
    expect(row("anna")?.status).toBe("active");
    expect(await run(["unlock", "anna"])).toBe(0);

    expect(await run(["reset-login", "anna"])).toBe(0);
    expect(out[0]).toMatch(/^Reset code for anna: \S+/);
    expect(row("anna")?.passwordHash).toBeNull();

    expect(cliEvents()).toEqual(["disable", "enable", "unlock", "reset_login"]);
  });

  it("answers 1 with a message for an unknown account and makes only active accounts admin", async () => {
    const { t, run, err, row } = await cli();
    expect(await run(["unlock", "nobody"])).toBe(1);
    expect(err[0]).toBe("There is no account nobody.");

    await t.asAccount({ username: "petra", status: "pending" });
    expect(await run(["make-admin", "petra"])).toBe(1);
    expect(row("petra")?.role).toBe("user");
    expect(await run(["make-admin", "anna"])).toBe(0);
    expect(row("anna")?.role).toBe("admin");
  });

  it("prints a setup code only while no admin exists and the env does not fix it", async () => {
    const { run, out, err } = await cli();
    expect(await run(["setup-code"], { SLOPPANIZER_SETUP_CODE: "TESTSETUPCODE0000000000000" })).toBe(1);
    expect(err[0]).toContain("fixed");
    expect(await run(["setup-code"])).toBe(0);
    expect(out[0]).toMatch(/^New setup code/);

    expect(await run(["make-admin", "anna"])).toBe(0);
    expect(await run(["setup-code"])).toBe(1);
    expect(err[0]).toContain("exists already");
  });

  it("writes a backup into the backups folder", async () => {
    const { t, run, out, cliEvents } = await cli();
    expect(await run(["backup"])).toBe(0);
    const [backup] = listBackups(t.config.backupDir);
    expect(out[0]).toContain(backup?.fileName);
    expect(cliEvents()).toEqual(["backup"]);
  });
});
