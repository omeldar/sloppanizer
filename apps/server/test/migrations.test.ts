import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, openDb, schemaVersion } from "../src/db/index.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A database migrated up to the first `count` journal entries, as an older installed app has it. */
function olderDatabase(tags: readonly string[]): { file: string; sqlite: Database.Database } {
  const root = mkdtempSync(join(tmpdir(), "organizer-migrate-"));
  roots.push(root);
  const folder = join(root, "drizzle");
  mkdirSync(join(folder, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  const step1 = journal.entries.slice(0, tags.length);
  expect(step1.map((e) => e.tag)).toEqual(tags);
  for (const entry of step1)
    copyFileSync(join(MIGRATIONS_DIR, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: step1 }));
  const file = join(root, "organizer.db");
  const sqlite = new Database(file);
  sqlite.pragma("foreign_keys = ON");
  migrate(drizzle(sqlite), { migrationsFolder: folder });
  return { file, sqlite };
}

/** Step 1 state: migrations 0000 and 0001 only. */
const step1Database = () => olderDatabase(["0000_init", "0001_seed_priority_labels"]);

const T = "2026-11-01T10:00:00.000Z";

describe("migrations from a step 1 database", () => {
  it("keeps every row, accepts the contact role and still enforces foreign keys", () => {
    const { file, sqlite } = step1Database();
    sqlite.exec(`
      INSERT INTO projects (id, slug, name, created_at, updated_at) VALUES (1, 'home', 'Home', '${T}', '${T}');
      INSERT INTO people (id, first_name, last_name, note, created_at, updated_at) VALUES
        (1, 'Anna', 'Meier', 'IT', '${T}', '${T}'),
        (2, 'Bo', 'Li', '', '${T}', '${T}');
      INSERT INTO todos (id, project_id, title, created_at, updated_at, last_activity_at) VALUES
        (1, 1, 'Renew certs', '${T}', '${T}', '${T}'),
        (2, NULL, 'Order cables', '${T}', '${T}', '${T}');
      INSERT INTO todo_people (todo_id, person_id, role, created_at) VALUES
        (1, 1, 'requester', '${T}'), (1, 2, 'requester', '${T}'), (2, 1, 'requester', '${T}');
      INSERT INTO events (id, todo_id, actor, kind, data, created_at) VALUES
        (1, 1, 'you', 'people_changed', '{"from":[],"to":[{"id":1,"name":"Anna Meier"}]}', '${T}'),
        (2, 1, 'you', 'status_changed', '{"from":"open","to":"done"}', '${T}');
    `);
    expect(() => sqlite.exec(`INSERT INTO todo_people VALUES (2, 2, 'contact', '${T}')`)).toThrow(
      /CHECK constraint/,
    );
    sqlite.close();

    const db = openDb(file);
    const raw = db.$client;
    expect(schemaVersion(db)).toBe(6);
    expect(
      raw.prepare("SELECT todo_id, person_id, role FROM todo_people ORDER BY todo_id, person_id").all(),
    ).toEqual([
      { todo_id: 1, person_id: 1, role: "requester" },
      { todo_id: 1, person_id: 2, role: "requester" },
      { todo_id: 2, person_id: 1, role: "requester" },
    ]);
    // The same person can be requester and contact on one todo.
    raw.prepare(`INSERT INTO todo_people VALUES (1, 1, 'contact', ?)`).run(T);
    expect(() => raw.prepare(`INSERT INTO todo_people VALUES (1, 2, 'owner', ?)`).run(T)).toThrow(
      /CHECK constraint/,
    );
    expect(() => raw.prepare(`INSERT INTO todo_people VALUES (1, 99, 'contact', ?)`).run(T)).toThrow(
      /FOREIGN KEY/,
    );
    expect(() => raw.prepare(`DELETE FROM people WHERE id = 2`).run()).toThrow(/FOREIGN KEY/);
    expect(raw.pragma("foreign_key_check")).toEqual([]);
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'todo_people_person_idx'").get()).toEqual(
      {
        name: "todo_people_person_idx",
      },
    );
    expect(raw.prepare("SELECT count(*) AS n FROM events").get()).toEqual({ n: 2 });
    // Deleting a todo still cascades to its links.
    raw.prepare("DELETE FROM todos WHERE id = 1").run();
    expect(raw.prepare("SELECT count(*) AS n FROM todo_people WHERE todo_id = 1").get()).toEqual({ n: 0 });
    db.$client.close();
  });

  it("backfills the role of old people_changed events and adds the new person columns", () => {
    const { file, sqlite } = step1Database();
    sqlite.exec(`
      INSERT INTO people (id, first_name, last_name, created_at, updated_at) VALUES (1, 'Anna', 'Meier', '${T}', '${T}');
      INSERT INTO todos (id, title, created_at, updated_at, last_activity_at) VALUES (1, 'x', '${T}', '${T}', '${T}');
      INSERT INTO events (id, todo_id, actor, kind, data, created_at) VALUES
        (1, 1, 'you', 'people_changed', '{"from":[],"to":[{"id":1,"name":"Anna Meier"}]}', '${T}'),
        (2, 1, 'you', 'status_changed', '{"from":"open","to":"done"}', '${T}');
    `);
    sqlite.close();
    const db = openDb(file);
    const raw = db.$client;
    const events = raw.prepare("SELECT id, data FROM events ORDER BY id").all() as {
      id: number;
      data: string;
    }[];
    expect(events.map((e) => JSON.parse(e.data))).toEqual([
      { from: [], to: [{ id: 1, name: "Anna Meier" }], role: "requester" },
      { from: "open", to: "done" },
    ]);
    expect(raw.prepare("SELECT team, email, notes_md FROM people").get()).toEqual({
      team: "",
      email: "",
      notes_md: "",
    });
    // Topic and person tag names are unique without case.
    raw.prepare("INSERT INTO topics (name, created_at) VALUES ('VPN', ?)").run(T);
    expect(() => raw.prepare("INSERT INTO topics (name, created_at) VALUES ('vpn', ?)").run(T)).toThrow(
      /UNIQUE/,
    );
    raw
      .prepare("INSERT INTO person_tags (name, created_at, updated_at) VALUES ('Fast reply', ?, ?)")
      .run(T, T);
    expect(() =>
      raw
        .prepare("INSERT INTO person_tags (name, created_at, updated_at) VALUES ('FAST REPLY', ?, ?)")
        .run(T, T),
    ).toThrow(/UNIQUE/);
    // The search table exists and folds umlauts.
    raw
      .prepare(
        "INSERT INTO search_fts (kind, ref_id, todo_id, title, body) VALUES ('person', 1, NULL, 'Hans Müller', '')",
      )
      .run();
    expect(raw.prepare(`SELECT ref_id FROM search_fts WHERE search_fts MATCH '"muller"'`).all()).toEqual([
      { ref_id: 1 },
    ]);
    db.$client.close();
  });

  it("gives attachments ids that are never reused", () => {
    const root = mkdtempSync(join(tmpdir(), "organizer-migrate-"));
    roots.push(root);
    const db = openDb(join(root, "organizer.db"));
    const insert = db.$client.prepare(
      "INSERT INTO attachments (name, mime_type, size, sha256, created_by, created_at) VALUES ('a', 'image/png', 1, 'x', 'you', ?)",
    );
    insert.run(T);
    const second = insert.run(T).lastInsertRowid;
    db.$client.prepare("DELETE FROM attachments WHERE id = ?").run(second);
    expect(insert.run(T).lastInsertRowid).toBe(3);
    db.$client.close();
  });
});

describe("migration 0005 on a step 2 database", () => {
  it("keeps rows, adds repeat columns and links, and enforces their rules", () => {
    const { file, sqlite } = olderDatabase([
      "0000_init",
      "0001_seed_priority_labels",
      "0002_step2_contacts_threads_notes",
      "0003_backfill_people_event_roles",
      "0004_search_index",
    ]);
    sqlite.exec(`
      INSERT INTO todos (id, parent_id, title, created_at, updated_at, last_activity_at) VALUES
        (1, NULL, 'Parent', '${T}', '${T}', '${T}'),
        (2, 1, 'Child', '${T}', '${T}', '${T}'),
        (3, NULL, 'Other', '${T}', '${T}', '${T}');
      INSERT INTO comments (id, todo_id, actor, body_md, created_at, updated_at) VALUES (1, 2, 'you', 'hi', '${T}', '${T}');
    `);
    sqlite.close();

    const db = openDb(file);
    const raw = db.$client;
    expect(schemaVersion(db)).toBe(6);
    expect(
      raw.prepare("SELECT id, parent_id, recurrence, recurrence_prev_id FROM todos ORDER BY id").all(),
    ).toEqual([
      { id: 1, parent_id: null, recurrence: null, recurrence_prev_id: null },
      { id: 2, parent_id: 1, recurrence: null, recurrence_prev_id: null },
      { id: 3, parent_id: null, recurrence: null, recurrence_prev_id: null },
    ]);
    expect(raw.prepare("SELECT count(*) AS n FROM comments").get()).toEqual({ n: 1 });
    // The repeat rule must be JSON; one next occurrence per todo.
    expect(() => raw.prepare("UPDATE todos SET recurrence = 'weekly' WHERE id = 1").run()).toThrow(/CHECK/);
    raw
      .prepare(`UPDATE todos SET recurrence = '{"every":"week"}', recurrence_prev_id = NULL WHERE id = 1`)
      .run();
    raw.prepare("UPDATE todos SET recurrence_prev_id = 1 WHERE id = 3").run();
    expect(() => raw.prepare("UPDATE todos SET recurrence_prev_id = 1 WHERE id = 2").run()).toThrow(/UNIQUE/);
    // Links: no self links, one row per pair and kind, cascade on delete.
    const link = raw.prepare(
      "INSERT INTO todo_links (from_id, to_id, kind, created_by, created_at) VALUES (?, ?, ?, 'you', ?)",
    );
    link.run(1, 3, "blocks", T);
    link.run(1, 3, "relates", T);
    expect(() => link.run(1, 3, "blocks", T)).toThrow(/UNIQUE/);
    expect(() => link.run(2, 2, "relates", T)).toThrow(/CHECK/);
    expect(() => link.run(2, 3, "parent", T)).toThrow(/CHECK/);
    expect(() => link.run(2, 99, "blocks", T)).toThrow(/FOREIGN KEY/);
    expect(raw.pragma("foreign_key_check")).toEqual([]);
    // Deleting a todo: links go, the next occurrence forgets it, children become top level.
    raw.prepare("DELETE FROM todos WHERE id = 1").run();
    expect(raw.prepare("SELECT count(*) AS n FROM todo_links").get()).toEqual({ n: 0 });
    expect(raw.prepare("SELECT id, parent_id, recurrence_prev_id FROM todos ORDER BY id").all()).toEqual([
      { id: 2, parent_id: null, recurrence_prev_id: null },
      { id: 3, parent_id: null, recurrence_prev_id: null },
    ]);
    const indexes = raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('todos_parent_idx', 'todos_recurrence_prev_idx', 'todo_links_to_idx') ORDER BY name",
      )
      .all();
    expect(indexes).toHaveLength(3);
    db.$client.close();
  });
});
