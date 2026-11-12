import { strFromU8, unzipSync } from "fflate";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.ts";
import { EXPORT_TABLES } from "../src/services/export.ts";
import { repairNameKeys } from "../src/services/name-keys.ts";
import { replaceAllData } from "../src/services/restore-data.ts";
import { fillEveryTable } from "./fixtures.ts";
import { makeApp } from "./helpers.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const tableRows = (sqlite: ReturnType<typeof openDb>["$client"], table: string) =>
  sqlite.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();

describe("export data.json", () => {
  it("loads into a fresh database with every row, id and sequence unchanged", async () => {
    const t = await makeApp();
    await fillEveryTable(t);
    const res = await t.call("GET", "/api/v1/export.zip");
    expect(res.statusCode).toBe(200);
    const files = unzipSync(res.rawPayload);
    const data = JSON.parse(strFromU8(files["data.json"] as Uint8Array));
    const manifest = JSON.parse(strFromU8(files["manifest.json"] as Uint8Array));
    const source = t.deps.db.$client;
    const sourceSeq = source
      .prepare("SELECT name, seq FROM sqlite_sequence WHERE name IN ('todos','attachments') ORDER BY name")
      .all();
    expect(manifest.sequences).toEqual({
      todos: (sourceSeq.find((r) => (r as { name: string }).name === "todos") as { seq: number }).seq,
      attachments: (sourceSeq.find((r) => (r as { name: string }).name === "attachments") as { seq: number })
        .seq,
    });

    const root = mkdtempSync(join(tmpdir(), "organizer-roundtrip-"));
    roots.push(root);
    const target = openDb(join(root, "fresh.db"));
    const sqlite = target.$client;
    // data.json leaves out the derived name keys; a restore refills them right after (as applyRestore does).
    sqlite.transaction(() => {
      replaceAllData(sqlite, data, manifest.sequences);
      expect(repairNameKeys(sqlite)).toBe(0);
    })();
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    const everything = (db: typeof source) =>
      Object.fromEntries(EXPORT_TABLES.map((table) => [table, tableRows(db, table)]));
    expect(everything(sqlite)).toEqual(everything(source));
    expect(EXPORT_TABLES.filter((table) => tableRows(source, table).length === 0)).toEqual([]);
    expect(
      sqlite
        .prepare("SELECT name, seq FROM sqlite_sequence WHERE name IN ('todos','attachments') ORDER BY name")
        .all(),
    ).toEqual(sourceSeq);
    // The next todo gets a new id, not the one of the deleted newest todo.
    const next = sqlite
      .prepare(
        "INSERT INTO todos (title, created_at, updated_at, last_activity_at) VALUES ('n', 'x', 'x', 'x')",
      )
      .run().lastInsertRowid;
    expect(Number(next)).toBe(manifest.sequences.todos + 1);
    target.$client.close();
  });
});
