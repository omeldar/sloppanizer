import { SCHEMA_BASE } from "@organizer/shared";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Db, openDb, SINGLE_USER_DATA_DIR, schemaVersion } from "../src/db/index.ts";
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
    // The baseline (9), then one per migration: 0001 oauth, 0002 planner and links, 0003 calendar feed.
    expect(schemaVersion(db)).toBe(SCHEMA_BASE + 4);
    expect(schemaVersion(db)).toBe(12);
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
    // Account 2 has only todo #1 (no label, person, topic, tag or project of its own).
    sqlite.exec(
      `INSERT INTO todos (account_id, id, title, created_at, updated_at, last_activity_at) VALUES (2, 1, 'B', '${T}', '${T}', '${T}')`,
    );
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
    // One next occurrence per todo and account.
    sqlite.exec(`UPDATE todos SET recurrence_prev_id = 1 WHERE account_id = 1 AND id = 2`);
    sqlite.exec(`UPDATE todos SET recurrence_prev_id = 1 WHERE account_id = 2 AND id = 2`);
  });

  it("deletes every row of an account with it and leaves the other account alone", () => {
    const { sqlite } = freshDb();
    for (const account of [1, 2]) {
      fillAccount(sqlite, account);
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
