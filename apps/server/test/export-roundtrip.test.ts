import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ID_TABLES } from "../src/db/schema.ts";
import { EXPORT_TABLES } from "../src/services/export.ts";
import { repairNameKeys } from "../src/services/name-keys.ts";
import { nextId } from "../src/services/owned.ts";
import { replaceAccountData } from "../src/services/restore-data.ts";
import { fillEveryTable } from "./fixtures.ts";
import { makeApp } from "./helpers.ts";

type Sqlite = Awaited<ReturnType<typeof makeApp>>["deps"]["db"]["$client"];

const physical = (table: string) => (table === "settings" ? "account_settings" : table);

/** The account's rows of a table without account_id (local settings left out). */
const accountRows = (sqlite: Sqlite, table: string, accountId: number) =>
  (
    sqlite
      .prepare(`SELECT * FROM "${physical(table)}" WHERE account_id = ? ORDER BY rowid`)
      .all(accountId) as Record<string, unknown>[]
  )
    .filter((row) => !(table === "settings" && row.key === "restoreInProgress"))
    .map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "account_id")));

const everything = (sqlite: Sqlite, accountId: number) =>
  Object.fromEntries(EXPORT_TABLES.map((table) => [table, accountRows(sqlite, table, accountId)]));

describe("export data.json", () => {
  it("loads into another account of a fresh server with every row, id and sequence unchanged", async () => {
    const t = await makeApp();
    await fillEveryTable(t);
    const res = await t.call("GET", "/api/v1/export.zip");
    expect(res.statusCode).toBe(200);
    const files = unzipSync(res.rawPayload);
    const data = JSON.parse(strFromU8(files["data.json"] as Uint8Array));
    const manifest = JSON.parse(strFromU8(files["manifest.json"] as Uint8Array));
    const source = t.deps.db.$client;

    // Every id table has a sequence; the deleted newest todo and attachment keep them ahead of the ids.
    expect(Object.keys(manifest.sequences).toSorted()).toEqual([...ID_TABLES].toSorted());
    for (const table of ["todos", "attachments"]) {
      const { maxId } = source
        .prepare(`SELECT max(id) AS maxId FROM "${table}" WHERE account_id = ?`)
        .get(t.account.id) as { maxId: number };
      expect(manifest.sequences[table]).toBeGreaterThan(maxId);
    }
    // data.json carries no account ids.
    expect(JSON.stringify(data)).not.toContain("account_id");

    const fresh = await makeApp();
    const bo = await fresh.asAccount({ username: "bo" });
    const target = fresh.deps.db.$client;
    target.transaction(() => {
      replaceAccountData(target, bo.account.id, data, manifest.sequences);
      // data.json leaves out the derived name keys; a restore refills them right after.
      expect(repairNameKeys(target, bo.account.id)).toBe(0);
    })();
    expect(target.pragma("foreign_key_check")).toEqual([]);

    expect(everything(target, bo.account.id)).toEqual(everything(source, t.account.id));
    expect(EXPORT_TABLES.filter((table) => accountRows(source, table, t.account.id).length === 0)).toEqual(
      [],
    );
    // The next todo gets a new id, not the one of the deleted newest todo.
    expect(target.transaction(() => nextId(bo.ctx(), "todos"))()).toBe(manifest.sequences.todos + 1);
  });
});
