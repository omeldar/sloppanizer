import type { Todo } from "@organizer/shared";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { EXPORT_TABLES } from "../src/services/export.ts";
import { makeApp } from "./helpers.ts";

describe("GET /export.zip", () => {
  it("contains every row with its original id, valid front matter and no secrets", async () => {
    const t = await makeApp({ now: "2026-11-11T13:04:05.000Z", timeZone: "Europe/Zurich" });
    const project = await t.create<{ id: number }>("/api/v1/projects", { name: "Home lab" });
    await t.create("/api/v1/labels", { name: "homelab" });
    const first = await t.create<Todo>("/api/v1/todos", { title: "Throwaway" });
    await t.call("DELETE", `/api/v1/todos/${first.id}`);
    const todo = await t.create<Todo>("/api/v1/todos", {
      title: "Renew SSL certs: all of them",
      descriptionMd: "---\nnot front matter\n",
      projectId: project.id,
      labels: ["priority::high", "homelab"],
      requestedBy: [{ firstName: "Anna", lastName: "Meier" }],
      dueOn: "2026-11-20",
    });
    t.advance(3 * 86_400_000);
    await t.call("PATCH", `/api/v1/todos/${todo.id}`, { status: "done" });
    const plain = await t.create<Todo>("/api/v1/todos", { title: "!!!" });
    const raw = t.token("assistant", "write");

    const res = await t.call("GET", "/api/v1/export.zip");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(res.headers["content-disposition"]).toBe(
      'attachment; filename="organizer-export-20261114-140405.zip"',
    );
    const files = unzipSync(res.rawPayload);
    const names = Object.keys(files).toSorted();
    expect(names).toEqual([
      "README.md",
      "data.json",
      "manifest.json",
      "todos/0002-renew-ssl-certs-all-of-them.md",
      "todos/0003-todo.md",
    ]);

    const manifest = JSON.parse(strFromU8(files["manifest.json"] as Uint8Array));
    expect(manifest).toMatchObject({
      app: "organizer",
      format: 1,
      exportedAt: "2026-11-14T13:04:05.000Z",
      appVersion: "0.1.0",
      schemaVersion: 2,
    });

    const data = JSON.parse(strFromU8(files["data.json"] as Uint8Array));
    expect(Object.keys(data).toSorted()).toEqual([...EXPORT_TABLES].toSorted());
    const sqlite = t.deps.db.$client;
    for (const table of EXPORT_TABLES) {
      const rows = sqlite.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
      expect(data[table]).toEqual(rows);
      expect(manifest.counts[table]).toBe(rows.length);
    }
    expect(data.todos.map((r: { id: number }) => r.id)).toEqual([todo.id, plain.id]);
    expect(data.labels).toHaveLength(5);
    expect(data.events.length).toBeGreaterThan(0);
    expect(data.settings).toEqual([
      { key: "lastExportAt", value: JSON.stringify("2026-11-14T13:04:05.000Z") },
    ]);
    const everything = names.map((n) => strFromU8(files[n] as Uint8Array)).join("\n");
    expect(everything).not.toContain(raw);
    expect(everything).not.toContain("token_hash");

    const md = strFromU8(files["todos/0002-renew-ssl-certs-all-of-them.md"] as Uint8Array);
    const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(md);
    expect(match).not.toBeNull();
    expect(parse(match?.[1] ?? "")).toEqual({
      id: todo.id,
      title: "Renew SSL certs: all of them",
      status: "done",
      project: "home-lab",
      labels: ["priority::high", "homelab"],
      requested_by: ["Anna Meier"],
      due: "2026-11-20",
      planned: null,
      created: "2026-11-11T13:04:05.000Z",
      done: "2026-11-14T13:04:05.000Z",
      took: "3d",
    });
    expect(match?.[2]).toBe("---\nnot front matter\n");
    const plainMd = strFromU8(files["todos/0003-todo.md"] as Uint8Array);
    expect(parse(/^---\n([\s\S]*?)\n---/.exec(plainMd)?.[1] ?? "")).toMatchObject({
      id: plain.id,
      title: "!!!",
      took: null,
      project: null,
    });
  });
});
