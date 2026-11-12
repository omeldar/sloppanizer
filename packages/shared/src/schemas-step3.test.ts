import { describe, expect, it } from "vitest";
import {
  ApplyRestore,
  CreateLinks,
  CreateSubtasks,
  PeopleStatsQuery,
  PersonStatsQuery,
  RestoreParams,
  Settings,
  ToggleChecklist,
  UpdateLabel,
} from "./index.ts";

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe("step 3 inputs", () => {
  it("checks links: kinds, 1..50 items, no extra fields", () => {
    expect(ok(CreateLinks, { links: [{ kind: "blocked_by", todoId: 3 }] })).toBe(true);
    expect(ok(CreateLinks, { links: [] })).toBe(false);
    expect(ok(CreateLinks, { links: [{ kind: "parent", todoId: 3 }] })).toBe(false);
    expect(ok(CreateLinks, { links: [{ kind: "blocks", todoId: 3, note: "x" }] })).toBe(false);
    expect(
      ok(CreateLinks, { links: Array.from({ length: 51 }, (_, i) => ({ kind: "relates", todoId: i + 1 })) }),
    ).toBe(false);
  });

  it("checks subtask titles like todo titles", () => {
    expect(CreateSubtasks.parse({ titles: ["  Buy  ", "Fix"] }).titles).toEqual(["Buy", "Fix"]);
    expect(ok(CreateSubtasks, { titles: [] })).toBe(false);
    expect(ok(CreateSubtasks, { titles: ["   "] })).toBe(false);
    expect(ok(CreateSubtasks, { titles: ["x".repeat(301)] })).toBe(false);
  });

  it("checks checklist toggles, restore confirm and the label rename option", () => {
    expect(ok(ToggleChecklist, { index: 0, checked: true, text: "Order" })).toBe(true);
    expect(ok(ToggleChecklist, { index: -1, checked: true })).toBe(false);
    expect(ok(ApplyRestore, { confirm: "replace" })).toBe(true);
    expect(ok(ApplyRestore, { confirm: "yes" })).toBe(false);
    expect(ok(UpdateLabel, { name: "a::b", onScopeConflict: "replace" })).toBe(true);
    expect(ok(UpdateLabel, { onScopeConflict: "replace" })).toBe(false);
    expect(ok(UpdateLabel, { name: "a::b", onScopeConflict: "merge" })).toBe(false);
  });
});

describe("step 3 queries and outputs", () => {
  it("fills people statistics defaults and refuses a reversed period", () => {
    expect(PeopleStatsQuery.parse({})).toEqual({ role: "requester", sort: "total", limit: 50 });
    expect(PeopleStatsQuery.parse({ topic: "dns,firewall", projectId: "inbox", limit: "5" })).toMatchObject({
      topic: ["dns", "firewall"],
      projectId: "inbox",
      limit: 5,
    });
    expect(ok(PeopleStatsQuery, { from: "2026-11-10", to: "2026-11-01" })).toBe(false);
    expect(ok(PeopleStatsQuery, { limit: "501" })).toBe(false);
    expect(ok(PersonStatsQuery, { role: "contact" })).toBe(false);
    expect(ok(PersonStatsQuery, { sort: "name" })).toBe(false);
  });

  it("accepts only 32 hex upload ids and strict settings", () => {
    expect(ok(RestoreParams, { uploadId: "a".repeat(32) })).toBe(true);
    expect(ok(RestoreParams, { uploadId: "../../etc/passwd" })).toBe(false);
    const settings = {
      exportDir: "/d/exports",
      folderExportKeep: 4,
      dataDir: "/d",
      lastExportAt: null,
      lastFolderExport: null,
      version: "0.1.0",
    };
    expect(ok(Settings, settings)).toBe(true);
    expect(ok(Settings, { ...settings, https: null })).toBe(false);
  });
});
