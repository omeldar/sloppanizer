import { SCHEMA_BASE } from "@organizer/shared";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Db, MIGRATIONS_DIR, openDb, SINGLE_USER_DATA_DIR, schemaVersion } from "../src/db/index.ts";
import { ID_TABLES } from "../src/db/schema.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempFile(): string {
  const root = mkdtempSync(join(tmpdir(), "sloppanizer-migrate-"));
  roots.push(root);
  return join(root, "sloppanizer.db");
}

const T = "2026-11-01T10:00:00.000Z";

/** A fresh baseline database with two accounts (ids 1 and 2). */
function freshDb(): { db: Db; sqlite: Database.Database } {
  const db = openDb(tempFile());
  const sqlite = db.$client;
  const add = sqlite.prepare(
    `INSERT INTO accounts (id, username, display_name, time_zone, status, webauthn_user_id, created_at, updated_at)
     VALUES (?, ?, ?, 'UTC', 'active', ?, ?, ?)`,
  );
  add.run(1, "anna", "Anna", "w-anna", T, T);
  add.run(2, "bo", "Bo", "w-bo", T, T);
  return { db, sqlite };
}

/** The same rows in an account: todo #1 and #2, label, person, topic, tag and project #1. */
function fillAccount(sqlite: Database.Database, account: number): void {
  sqlite.exec(`
    INSERT INTO projects (account_id, id, slug, name, created_at, updated_at) VALUES (${account}, 1, 'home', 'Home', '${T}', '${T}');
    INSERT INTO todos (account_id, id, title, created_at, updated_at, last_activity_at) VALUES
      (${account}, 1, 'One', '${T}', '${T}', '${T}'), (${account}, 2, 'Two', '${T}', '${T}', '${T}');
    INSERT INTO labels (account_id, id, name, name_key, value, color, created_at, updated_at)
      VALUES (${account}, 1, 'ops', 'ops', 'ops', '#8B95A5', '${T}', '${T}');
    INSERT INTO people (account_id, id, first_name, last_name, created_at, updated_at)
      VALUES (${account}, 1, 'Ada', 'Lane', '${T}', '${T}');
    INSERT INTO topics (account_id, id, name, name_key, created_at) VALUES (${account}, 1, 'dns', 'dns', '${T}');
    INSERT INTO person_tags (account_id, id, name, name_key, created_at, updated_at)
      VALUES (${account}, 1, 'kind', 'kind', '${T}', '${T}');
  `);
}

/**
 * A standup with a series, a cancelled date, a note on a date, a said mark on todo #1 and todo #2 added
 * by hand (needs fillAccount).
 */
function fillMeetings(sqlite: Database.Database, account: number): void {
  sqlite.exec(`
    INSERT INTO meetings (account_id, id, name, type, since, created_at, updated_at)
      VALUES (${account}, 1, 'Standup', 'standup', '${T}', '${T}', '${T}');
    INSERT INTO series (account_id, id, owner_kind, meeting_id, rule, starts_on, start_time, duration_min, created_at, updated_at)
      VALUES (${account}, 1, 'meeting', 1, '{"every":"week","interval":1,"weekdays":["thu"],"basis":"schedule"}',
        '2026-11-05', '09:00', 15, '${T}', '${T}');
    INSERT INTO series_exceptions (account_id, series_id, occurs_on, kind, created_at, updated_at)
      VALUES (${account}, 1, '2026-11-12', 'cancelled', '${T}', '${T}');
    INSERT INTO notes (account_id, id, title, created_by, created_at, updated_at)
      VALUES (${account}, 1, 'Standup 05.11.2026', 'you', '${T}', '${T}');
    INSERT INTO meeting_notes (account_id, meeting_id, occurs_on, note_id, created_at)
      VALUES (${account}, 1, '2026-11-05', 1, '${T}');
    INSERT INTO standup_marks (account_id, meeting_id, todo_id, occurs_on, kind, covered_until, marked_at)
      VALUES (${account}, 1, 1, '2026-11-05', 'said', '${T}', '${T}');
    INSERT INTO meeting_todos (account_id, meeting_id, todo_id, added_at) VALUES (${account}, 1, 2, '${T}');
  `);
}

const countOf = (sqlite: Database.Database, table: string) =>
  (sqlite.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n;

/** Tables of the user data (every row belongs to an account). */
function userTables(sqlite: Database.Database): string[] {
  const auth = new Set([
    "accounts",
    "recovery_codes",
    "passkeys",
    "sessions",
    "login_throttle",
    "oauth_clients",
    "oauth_grants",
    "calendar_feeds",
    "ai_settings",
    "spaces",
    "space_members",
  ]);
  const rows = sqlite
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        AND name NOT LIKE '__drizzle%' AND name NOT LIKE 'search_fts%'`,
    )
    .all() as { name: string }[];
  return rows
    .map((r) => r.name)
    .filter((name) => !auth.has(name) && name !== "admin_events" && name !== "instance_settings");
}

/** What every user table looks like. */
const expectedShape = (table: string) => ({
  accountNotNull: true,
  cascadesFromAccounts: true,
  // api_tokens: global id (tokens are auth objects), UNIQUE (account_id, id) instead.
  key:
    table === "api_tokens"
      ? ["id"]
      : (ID_TABLES as readonly string[]).includes(table)
        ? ["account_id", "id"]
        : ["account_id"],
});

describe("baseline migration", () => {
  it("counts on from the single-user versions, so every single-user export (8 or lower) is older", () => {
    const { db } = freshDb();
    // The baseline (9), then one per migration: 0001 oauth, 0002 planner and links, 0003 calendar feed, 0004 ai
    // settings, 0005 person languages, 0006 meetings, 0007 todos on meetings, 0008 todo series, 0009 shared projects, 0010 date and time formats.
    expect(schemaVersion(db)).toBe(SCHEMA_BASE + 11);
    expect(schemaVersion(db)).toBe(19);
  });

  it("gives every user table an account_id and every id table the key (account_id, id)", () => {
    const { sqlite } = freshDb();
    const tables = userTables(sqlite);
    expect(tables).toEqual(expect.arrayContaining([...ID_TABLES, "todo_labels", "account_settings"]));
    const shape = (table: string) => {
      const columns = sqlite.prepare(`SELECT name, "notnull", pk FROM pragma_table_info(?)`).all(table) as {
        name: string;
        notnull: number;
        pk: number;
      }[];
      const fks = sqlite
        .prepare(`SELECT "table", "from", on_delete FROM pragma_foreign_key_list(?)`)
        .all(table) as { table: string; from: string; on_delete: string }[];
      return {
        accountNotNull: columns.find((c) => c.name === "account_id")?.notnull === 1,
        cascadesFromAccounts: fks.some(
          (fk) => fk.table === "accounts" && fk.from === "account_id" && fk.on_delete === "CASCADE",
        ),
        key: columns
          .filter((c) => c.pk > 0)
          .toSorted((x, y) => x.pk - y.pk)
          .map((c) => c.name)
          .slice(0, (ID_TABLES as readonly string[]).includes(table) ? undefined : 1),
      };
    };
    expect(Object.fromEntries(tables.map((t) => [t, shape(t)]))).toEqual(
      Object.fromEntries(tables.map((t) => [t, expectedShape(t)])),
    );
  });

  it("refuses links between two accounts' rows in every reference", () => {
    const { sqlite } = freshDb();
    fillAccount(sqlite, 1);
    fillMeetings(sqlite, 1);
    // Account 2 has only todo #1 and meeting #5 (no label, person, topic, tag, project or note of its own).
    sqlite.exec(`
      INSERT INTO todos (account_id, id, title, created_at, updated_at, last_activity_at) VALUES (2, 1, 'B', '${T}', '${T}', '${T}');
      INSERT INTO meetings (account_id, id, name, since, created_at, updated_at) VALUES (2, 5, 'Mine', '${T}', '${T}', '${T}');
    `);
    const mixed = [
      `INSERT INTO todo_labels (account_id, todo_id, label_id) VALUES (2, 1, 1)`,
      `INSERT INTO todo_people (account_id, todo_id, person_id, role, created_at) VALUES (2, 1, 1, 'requester', '${T}')`,
      `INSERT INTO person_topics (account_id, person_id, topic_id, created_at) VALUES (2, 1, 1, '${T}')`,
      `INSERT INTO person_tag_links (account_id, person_id, tag_id, created_at) VALUES (2, 1, 1, '${T}')`,
      `INSERT INTO todo_links (account_id, id, from_id, to_id, kind, created_by, created_at) VALUES (2, 1, 1, 2, 'blocks', 'you', '${T}')`,
      `INSERT INTO comments (account_id, id, todo_id, actor, body_md, created_at, updated_at, author_kind) VALUES (2, 1, 2, 'you', 'x', '${T}', '${T}', 'session')`,
      `INSERT INTO events (account_id, id, todo_id, actor, kind, data, created_at) VALUES (2, 1, 2, 'you', 'created', '{}', '${T}')`,
      `UPDATE todos SET project_id = 1 WHERE account_id = 2 AND id = 1`,
      `UPDATE todos SET parent_id = 2 WHERE account_id = 2 AND id = 1`,
      `UPDATE todos SET recurrence_prev_id = 2 WHERE account_id = 2 AND id = 1`,
      `INSERT INTO notes (account_id, id, project_id, title, created_by, created_at, updated_at) VALUES (2, 1, 1, 'N', 'you', '${T}', '${T}')`,
      `INSERT INTO series (account_id, id, owner_kind, meeting_id, rule, starts_on, start_time, duration_min, created_at, updated_at) VALUES (2, 1, 'meeting', 1, '{}', '2026-11-05', '09:00', 15, '${T}', '${T}')`,
      `INSERT INTO series_exceptions (account_id, series_id, occurs_on, kind, created_at, updated_at) VALUES (2, 1, '2026-11-05', 'cancelled', '${T}', '${T}')`,
      `INSERT INTO meeting_notes (account_id, meeting_id, occurs_on, note_id, created_at) VALUES (2, 5, '2026-11-05', 1, '${T}')`,
      `INSERT INTO standup_marks (account_id, meeting_id, todo_id, occurs_on, kind, covered_until, marked_at) VALUES (2, 5, 2, '2026-11-05', 'said', '${T}', '${T}')`,
      `INSERT INTO standup_marks (account_id, meeting_id, todo_id, occurs_on, kind, covered_until, marked_at) VALUES (2, 1, 1, '2026-11-05', 'said', '${T}', '${T}')`,
      `INSERT INTO meeting_todos (account_id, meeting_id, todo_id, added_at) VALUES (2, 5, 2, '${T}')`,
      `INSERT INTO meeting_todos (account_id, meeting_id, todo_id, added_at) VALUES (2, 1, 1, '${T}')`,
    ];
    const outcome = (statement: string) => {
      try {
        sqlite.exec(statement);
        return "accepted";
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(mixed.map(outcome)).toEqual(mixed.map(() => "FOREIGN KEY constraint failed"));
    // The same links inside one account are fine.
    sqlite.exec(`INSERT INTO todo_labels (account_id, todo_id, label_id) VALUES (1, 1, 1)`);
    sqlite.exec(`UPDATE todos SET parent_id = 2, project_id = 1 WHERE account_id = 1 AND id = 1`);
  });

  it("counts names unique per account, without ASCII case", () => {
    const { sqlite } = freshDb();
    fillAccount(sqlite, 1);
    fillAccount(sqlite, 2);
    expect(() =>
      sqlite.exec(
        `INSERT INTO labels (account_id, id, name, name_key, value, color, created_at, updated_at) VALUES (1, 2, 'OPS', NULL, 'x', '#8B95A5', '${T}', '${T}')`,
      ),
    ).toThrow(/UNIQUE/);
    expect(() =>
      sqlite.exec(
        `INSERT INTO projects (account_id, id, slug, name, created_at, updated_at) VALUES (1, 2, 'home', 'Again', '${T}', '${T}')`,
      ),
    ).toThrow(/UNIQUE/);
    expect(() =>
      sqlite.exec(`UPDATE todos SET recurrence = 'not json' WHERE account_id = 1 AND id = 1`),
    ).toThrow(/CHECK/);
    fillMeetings(sqlite, 1);
    expect(() => sqlite.exec(`UPDATE series SET rule = 'not json' WHERE account_id = 1`)).toThrow(/CHECK/);
    expect(() => sqlite.exec(`UPDATE meetings SET filter = '{' WHERE account_id = 1`)).toThrow(/CHECK/);
    expect(() => sqlite.exec(`UPDATE meetings SET type = 'retro' WHERE account_id = 1`)).toThrow(/CHECK/);
    expect(() => sqlite.exec(`UPDATE series SET ends_on = '2026-11-01' WHERE account_id = 1`)).toThrow(
      /CHECK/,
    );
    expect(() => sqlite.exec(`UPDATE series_exceptions SET kind = 'moved' WHERE account_id = 1`)).toThrow(
      /CHECK/,
    );
    // A note belongs to one meeting date at most.
    expect(() =>
      sqlite.exec(
        `INSERT INTO meeting_notes (account_id, meeting_id, occurs_on, note_id, created_at) VALUES (1, 1, '2026-11-19', 1, '${T}')`,
      ),
    ).toThrow(/UNIQUE/);
    // One next occurrence per todo and account.
    sqlite.exec(`UPDATE todos SET recurrence_prev_id = 1 WHERE account_id = 1 AND id = 2`);
    sqlite.exec(`UPDATE todos SET recurrence_prev_id = 1 WHERE account_id = 2 AND id = 2`);
  });

  it("deletes a meeting's series, dates, marks, note and todo links with it, but keeps notes and todos", () => {
    const { sqlite } = freshDb();
    fillAccount(sqlite, 1);
    fillMeetings(sqlite, 1);
    sqlite.exec("DELETE FROM notes WHERE account_id = 1 AND id = 1");
    expect(countOf(sqlite, "meeting_notes")).toBe(0);
    sqlite.exec("DELETE FROM todos WHERE account_id = 1 AND id = 1");
    expect(countOf(sqlite, "standup_marks")).toBe(0);
    // A todo added by hand leaves the meeting when the todo is deleted.
    sqlite.exec(
      `INSERT INTO todos (account_id, id, title, created_at, updated_at, last_activity_at) VALUES (1, 3, 'Three', '${T}', '${T}', '${T}')`,
    );
    sqlite.exec(
      `INSERT INTO meeting_todos (account_id, meeting_id, todo_id, added_at) VALUES (1, 1, 3, '${T}')`,
    );
    sqlite.exec("DELETE FROM todos WHERE account_id = 1 AND id = 3");
    expect(countOf(sqlite, "meeting_todos")).toBe(1);
    sqlite.exec(`
      INSERT INTO notes (account_id, id, title, created_by, created_at, updated_at) VALUES (1, 2, 'N', 'you', '${T}', '${T}');
      INSERT INTO meeting_notes (account_id, meeting_id, occurs_on, note_id, created_at) VALUES (1, 1, '2026-11-19', 2, '${T}');
      INSERT INTO standup_marks (account_id, meeting_id, todo_id, occurs_on, kind, covered_until, marked_at)
        VALUES (1, 1, 2, '2026-11-19', 'dismissed', '${T}', '${T}');
    `);
    expect(countOf(sqlite, "series_exceptions")).toBe(1);
    sqlite.exec("DELETE FROM meetings WHERE account_id = 1 AND id = 1");
    const left = ["series", "series_exceptions", "meeting_notes", "standup_marks", "meeting_todos"].map(
      (table) => countOf(sqlite, table),
    );
    expect(left).toEqual([0, 0, 0, 0, 0]);
    expect(countOf(sqlite, "todos")).toBe(1);
    expect(countOf(sqlite, "notes")).toBe(1);
  });

  it("deletes every row of an account with it and leaves the other account alone", () => {
    const { sqlite } = freshDb();
    for (const account of [1, 2]) {
      fillAccount(sqlite, account);
      fillMeetings(sqlite, account);
      sqlite.exec(`
        UPDATE todos SET parent_id = 1, project_id = 1 WHERE account_id = ${account} AND id = 2;
        INSERT INTO todo_people VALUES (${account}, 1, 1, 'requester', '${T}');
        INSERT INTO todo_labels VALUES (${account}, 1, 1);
        INSERT INTO person_topics VALUES (${account}, 1, 1, '${T}');
        INSERT INTO account_sequences VALUES (${account}, 'todos', 2);
        INSERT INTO account_settings VALUES (${account}, 'lastExportAt', 'null');
      `);
    }
    const count = (account: number) =>
      Object.fromEntries(
        userTables(sqlite).map((table) => [
          table,
          (
            sqlite.prepare(`SELECT count(*) AS n FROM "${table}" WHERE account_id = ?`).get(account) as {
              n: number;
            }
          ).n,
        ]),
      );
    const before = count(2);
    sqlite.prepare("DELETE FROM accounts WHERE id = 1").run();
    expect(Object.values(count(1)).every((n) => n === 0)).toBe(true);
    expect(count(2)).toEqual(before);
  });

  it("refuses a data dir of the single-user version with a plain message", () => {
    const file = tempFile();
    const old = new Database(file);
    old.exec("CREATE TABLE todos (id integer PRIMARY KEY, title text NOT NULL)");
    old.close();
    expect(() => openDb(file)).toThrow(SINGLE_USER_DATA_DIR);
    expect(SINGLE_USER_DATA_DIR).toContain("import the old export zip into an account");
  });
});

/** A copy of the migrations folder that stops before the migration with this tag. */
function migrationsBefore(tag: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), "sloppanizer-migrations-")), "drizzle");
  roots.push(dirname(dir));
  mkdirSync(join(dir, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  const stop = journal.entries.findIndex((e) => e.tag === tag);
  expect(stop).toBeGreaterThan(0);
  const entries = journal.entries.slice(0, stop);
  for (const { tag: name } of entries)
    copyFileSync(join(MIGRATIONS_DIR, `${name}.sql`), join(dir, `${name}.sql`));
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  return dir;
}

const peopleRows = (sqlite: Database.Database) =>
  sqlite
    .prepare(
      "SELECT account_id, id, first_name, last_name, team, email, notes_md FROM people ORDER BY account_id, id",
    )
    .all();

describe("person languages migration", () => {
  it("keeps the people of every account and gives them no languages", () => {
    const file = tempFile();
    const old = new Database(file);
    old.pragma("foreign_keys = ON");
    migrate(drizzle(old), { migrationsFolder: migrationsBefore("0005_person_languages") });
    const columns = () =>
      (old.prepare("SELECT name FROM pragma_table_info('people')").all() as { name: string }[]).map(
        (c) => c.name,
      );
    expect(columns()).not.toContain("languages");
    const add = old.prepare(
      `INSERT INTO accounts (id, username, display_name, time_zone, status, webauthn_user_id, created_at, updated_at)
       VALUES (?, ?, ?, 'UTC', 'active', ?, ?, ?)`,
    );
    add.run(1, "anna", "Anna", "w-anna", T, T);
    add.run(2, "bo", "Bo", "w-bo", T, T);
    fillAccount(old, 1);
    fillAccount(old, 2);
    old.exec(`
      UPDATE people SET team = 'Network', email = 'ada@example.com', notes_md = 'Knows DNS' WHERE account_id = 1;
      INSERT INTO person_topics VALUES (1, 1, 1, '${T}');
      INSERT INTO todo_people VALUES (1, 1, 1, 'requester', '${T}');
    `);
    const before = peopleRows(old);
    old.close();

    const { $client: sqlite } = openDb(file);
    expect(peopleRows(sqlite)).toEqual(before);
    expect(sqlite.prepare("SELECT DISTINCT languages FROM people").all()).toEqual([{ languages: "" }]);
    // Links to the people survive too (the column is added in place, the table is not rebuilt).
    expect(sqlite.prepare("SELECT count(*) AS n FROM person_topics").get()).toEqual({ n: 1 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM todo_people").get()).toEqual({ n: 1 });
    sqlite.close();
  });
});

const seriesRows = (db: Database.Database) =>
  db.prepare("SELECT account_id, id, owner_kind, meeting_id, rule, starts_on FROM series").all();
const exceptionRows = (db: Database.Database) =>
  db.prepare("SELECT * FROM series_exceptions ORDER BY account_id, series_id, occurs_on").all();

describe("todo series migration", () => {
  it("keeps every meeting's repeat and its moved and cancelled dates while series gets todo owners", () => {
    const file = tempFile();
    const old = new Database(file);
    old.pragma("foreign_keys = ON");
    migrate(drizzle(old), { migrationsFolder: migrationsBefore("0008_todo_series") });
    const add = old.prepare(
      `INSERT INTO accounts (id, username, display_name, time_zone, status, webauthn_user_id, created_at, updated_at)
       VALUES (?, ?, ?, 'UTC', 'active', ?, ?, ?)`,
    );
    add.run(1, "anna", "Anna", "w-anna", T, T);
    add.run(2, "bo", "Bo", "w-bo", T, T);
    for (const account of [1, 2]) {
      fillAccount(old, account);
      fillMeetings(old, account);
    }
    const series = seriesRows(old);
    const exceptions = exceptionRows(old);
    expect(exceptions).toHaveLength(2);
    old.close();

    const { $client: sqlite } = openDb(file);
    expect(seriesRows(sqlite)).toEqual(series);
    expect(exceptionRows(sqlite)).toEqual(exceptions);
    expect(sqlite.prepare("SELECT DISTINCT todo_id FROM series").all()).toEqual([{ todo_id: null }]);
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name LIKE '__keep%'").all()).toEqual([]);
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    // A todo owns a repeat now; a row with two owners or none is refused.
    sqlite.exec(`INSERT INTO series (account_id, id, owner_kind, todo_id, rule, starts_on, start_time, duration_min, created_at, updated_at)
      VALUES (1, 2, 'todo', 1, '{"every":"day","interval":1,"basis":"schedule"}', '2026-11-05', '08:00', 30, '${T}', '${T}')`);
    expect(() =>
      sqlite.exec(`INSERT INTO series (account_id, id, owner_kind, meeting_id, todo_id, rule, starts_on, start_time, duration_min, created_at, updated_at)
        VALUES (1, 3, 'todo', 1, 1, '{}', '2026-11-05', '08:00', 30, '${T}', '${T}')`),
    ).toThrow(/CHECK constraint failed: series_owner_check/);
    // Deleting the todo deletes its repeat.
    sqlite.exec("DELETE FROM todos WHERE account_id = 1 AND id = 1");
    expect(countOf(sqlite, "series")).toBe(2);
    sqlite.close();
  });
});
