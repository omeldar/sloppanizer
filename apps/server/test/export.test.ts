import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Todo } from "@organizer/shared";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  attachmentFileName,
  commentsSection,
  EXPORT_TABLES,
  markdownDocument,
  markdownPath,
  rewriteAttachmentLinks,
} from "../src/services/export.ts";
import { makeApp } from "./helpers.ts";

/** Rows as data.json holds them: the derived name keys are left out (a restore refills them). */
const KEYED = new Set(["labels", "topics", "person_tags"]);
const asExported = (table: string, rows: unknown[]) =>
  KEYED.has(table) ? rows.map((row) => ({ ...(row as object), name_key: undefined })) : rows;

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
      "people/0001-anna-meier.md",
      "todos/0002-renew-ssl-certs-all-of-them.md",
      "todos/0003-todo.md",
    ]);

    const manifest = JSON.parse(strFromU8(files["manifest.json"] as Uint8Array));
    expect(manifest).toMatchObject({
      app: "organizer",
      format: 3,
      exportedAt: "2026-11-14T13:04:05.000Z",
      appVersion: "0.1.0",
      schemaVersion: 7,
      attachments: { count: 0, bytes: 0, missing: [] },
    });

    const data = JSON.parse(strFromU8(files["data.json"] as Uint8Array));
    expect(Object.keys(data).toSorted()).toEqual([...EXPORT_TABLES].toSorted());
    const sqlite = t.deps.db.$client;
    for (const table of EXPORT_TABLES) {
      const rows = sqlite.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
      expect(data[table]).toEqual(asExported(table, rows));
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
      contacts: [],
      due: "2026-11-20",
      planned: null,
      created: "2026-11-11T13:04:05.000Z",
      done: "2026-11-14T13:04:05.000Z",
      took: "3d",
      parent: null,
      subtasks: [],
      blocks: [],
      blocked_by: [],
      relates_to: [],
      repeat: null,
      previous: null,
      next: null,
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

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Compression method per file name from the zip's central directory (0 = stored, 8 = deflate). */
function zipMethods(zip: Uint8Array): Record<string, number> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const methods: Record<string, number> = {};
  for (let at = 0; at + 46 <= zip.byteLength; at++) {
    if (view.getUint32(at, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(at + 28, true);
    const name = strFromU8(zip.subarray(at + 46, at + 46 + nameLength));
    methods[name] = view.getUint16(at + 10, true);
    at += 45 + nameLength;
  }
  return methods;
}

const frontMatter = (md: string) => {
  const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(md);
  expect(match).not.toBeNull();
  return { meta: parse(match?.[1] ?? "") as Record<string, unknown>, body: match?.[2] ?? "" };
};

describe("export format 3", () => {
  it("holds the new tables, the uploaded files and Markdown for notes and people", async () => {
    const t = await makeApp({ now: "2026-11-11T13:04:05.000Z", timeZone: "Europe/Zurich" });
    const sqlite = t.deps.db.$client;
    const at = "2026-11-11T13:04:05.000Z";
    const project = await t.create<{ id: number }>("/api/v1/projects", { name: "Home lab" });
    const todo = await t.create<Todo>("/api/v1/todos", {
      title: "Open port 443",
      descriptionMd: "See ![shot](/api/v1/attachments/1/shot.png)",
      requestedBy: [{ firstName: "Anna", lastName: "Meier" }],
    });
    const max = await t.create<{ id: number }>("/api/v1/people", { firstName: "Max", lastName: "Müller" });
    const anna = todo.requestedBy[0]?.id ?? 0;

    // Rows for the new tables straight into the database: this test is about the export, not the endpoints.
    sqlite
      .prepare("UPDATE people SET team = ?, email = ?, notes_md = ?, note = ? WHERE id = ?")
      .run(
        "Network team",
        "anna@example.com",
        "Knows the **old** setup.\n![net](/api/v1/attachments/2/net.txt)",
        "Basel",
        anna,
      );
    sqlite
      .prepare("INSERT INTO topics (id, name, created_at) VALUES (1, 'VPN', ?), (2, 'firewall rules', ?)")
      .run(at, at);
    sqlite
      .prepare("INSERT INTO person_topics (person_id, topic_id, created_at) VALUES (?, 1, ?), (?, 2, ?)")
      .run(anna, at, anna, at);
    sqlite
      .prepare(
        "INSERT INTO person_tags (id, name, color, created_at, updated_at) VALUES (1, 'fast reply', '#3E8E7E', ?, ?)",
      )
      .run(at, at);
    sqlite
      .prepare("INSERT INTO person_tag_links (person_id, tag_id, created_at) VALUES (?, 1, ?)")
      .run(anna, at);
    sqlite
      .prepare(
        "INSERT INTO todo_people (todo_id, person_id, role, created_at) VALUES (?, ?, 'contact', ?), (?, ?, 'contact', ?)",
      )
      .run(todo.id, max.id, at, todo.id, anna, at);
    sqlite
      .prepare(
        // The later comment gets the lower id: the Markdown still lists them by time.
        "INSERT INTO comments (todo_id, actor, body_md, created_at, updated_at) VALUES (?, 'planner', 'Done: [log](/api/v1/attachments/3/log.pdf)', ?, ?), (?, 'you', ?, ?, ?)",
      )
      .run(todo.id, "2026-11-12T08:00:00.000Z", at, todo.id, "Asked Max.\n", "2026-11-11T13:05:00.000Z", at);
    sqlite
      .prepare(
        "INSERT INTO notes (project_id, title, body_md, pinned_at, created_by, created_at, updated_at) VALUES (?, 'Router: setup', ?, ?, 'you', ?, ?), (NULL, 'Empty', '', NULL, 'planner', ?, ?)",
      )
      .run(project.id, "![shot](/api/v1/attachments/1/shot.png)", at, at, at, at, at);
    const png = Uint8Array.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...Array.from({ length: 300 }, () => 7),
    ]);
    const txt = new TextEncoder().encode("line\n".repeat(200));
    const insertAttachment = sqlite.prepare(
      "INSERT INTO attachments (name, mime_type, size, sha256, created_by, created_at) VALUES (?, ?, ?, ?, 'you', ?)",
    );
    insertAttachment.run("shot.png", "image/png", png.length, sha(png), at);
    insertAttachment.run("net.txt", "application/octet-stream", txt.length, sha(txt), at);
    insertAttachment.run("log.pdf", "application/pdf", 10, "0".repeat(64), at);
    const dir = join(t.dataDir, "attachments");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "1"), png);
    writeFileSync(join(dir, "2"), txt);
    // File 3 is missing on disk: listed in the manifest, the export still works.

    const res = await t.call("GET", "/api/v1/export.zip");
    expect(res.statusCode).toBe(200);
    const files = unzipSync(res.rawPayload);
    const text = (name: string) => strFromU8(files[name] as Uint8Array);
    expect(Object.keys(files).toSorted()).toEqual([
      "README.md",
      "attachments/1-shot.png",
      "attachments/2-net.txt",
      "data.json",
      "manifest.json",
      "notes/0001-router-setup.md",
      "notes/0002-empty.md",
      "people/0001-anna-meier.md",
      "people/0002-max-muller.md",
      "todos/0001-open-port-443.md",
    ]);
    expect(files["attachments/1-shot.png"]).toEqual(png);
    expect(files["attachments/2-net.txt"]).toEqual(txt);
    // Images and PDFs are compressed already and stored as they are; other files are deflated.
    const methods = zipMethods(res.rawPayload);
    expect(methods["attachments/1-shot.png"]).toBe(0);
    expect(methods["attachments/2-net.txt"]).toBe(8);

    const manifest = JSON.parse(text("manifest.json"));
    expect(manifest.format).toBe(3);
    expect(manifest.attachments).toEqual({ count: 2, bytes: png.length + txt.length, missing: [3] });
    const data = JSON.parse(text("data.json"));
    expect(Object.keys(data)).toEqual([...EXPORT_TABLES]);
    expect(data.search_fts).toBeUndefined();
    expect(text("data.json")).not.toContain('"name_key"');
    for (const table of EXPORT_TABLES) {
      const rows = sqlite.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
      expect(data[table]).toEqual(asExported(table, rows));
      expect(manifest.counts[table]).toBe(rows.length);
    }
    for (const table of ["topics", "person_tags", "person_topics", "person_tag_links", "notes", "comments"]) {
      expect(data[table].length).toBeGreaterThan(0);
    }
    expect(data.attachments.map((a: { id: number }) => a.id)).toEqual([1, 2, 3]);
    // data.json keeps the raw links, so a restore gives identical data.
    expect(data.todos[0].description_md).toBe("See ![shot](/api/v1/attachments/1/shot.png)");

    const todoMd = frontMatter(text("todos/0001-open-port-443.md"));
    // Same link time: by person id.
    expect(todoMd.meta.contacts).toEqual(["Anna Meier", "Max Müller"]);
    expect(todoMd.body).toBe(
      [
        "See ![shot](../attachments/1-shot.png)",
        "",
        "## Comments",
        "",
        "### you, 2026-11-11 14:05",
        "",
        "Asked Max.",
        "",
        "### planner, 2026-11-12 09:00",
        "",
        // The file is missing, so the link stays as it was.
        "Done: [log](/api/v1/attachments/3/log.pdf)",
        "",
      ].join("\n"),
    );

    const note = frontMatter(text("notes/0001-router-setup.md"));
    expect(note.meta).toEqual({
      id: 1,
      title: "Router: setup",
      project: "home-lab",
      pinned: true,
      created: at,
      updated: at,
      created_by: "you",
    });
    expect(note.body).toBe("![shot](../attachments/1-shot.png)\n");
    expect(frontMatter(text("notes/0002-empty.md"))).toEqual({
      meta: {
        id: 2,
        title: "Empty",
        project: null,
        pinned: false,
        created: at,
        updated: at,
        created_by: "planner",
      },
      body: "",
    });

    const annaMd = frontMatter(text("people/0001-anna-meier.md"));
    expect(annaMd.meta).toEqual({
      id: anna,
      name: "Anna Meier",
      team: "Network team",
      email: "anna@example.com",
      note: "Basel",
      topics: ["firewall rules", "VPN"],
      tags: ["fast reply"],
      requested: [todo.id],
      contact_for: [todo.id],
      created: at,
    });
    expect(annaMd.body).toBe("Knows the **old** setup.\n![net](../attachments/2-net.txt)\n");
    expect(frontMatter(text("people/0002-max-muller.md")).meta).toMatchObject({
      name: "Max Müller",
      topics: [],
      tags: [],
      requested: [],
      contact_for: [todo.id],
    });
    expect(text("README.md")).toContain("Export format 3.");
  });
});

describe("export Markdown helpers", () => {
  const files = new Map([
    [5, "5-screen-shot.png"],
    [12, "12-report.pdf"],
  ]);

  it("points attachment links at the copies in attachments/", () => {
    const md = [
      "![screen shot](/api/v1/attachments/5/screen-shot.png)",
      '[report](/api/v1/attachments/12/report.pdf "the report")',
      "bare /api/v1/attachments/12 and <http://organizer.localhost:4711/api/v1/attachments/5/x.png>",
      "[ref]: /api/v1/attachments/5/screen-shot.png",
    ].join("\n");
    expect(rewriteAttachmentLinks(md, files)).toBe(
      [
        "![screen shot](../attachments/5-screen-shot.png)",
        '[report](../attachments/12-report.pdf "the report")',
        "bare ../attachments/12-report.pdf and <../attachments/5-screen-shot.png>",
        "[ref]: ../attachments/5-screen-shot.png",
      ].join("\n"),
    );
  });

  it("leaves unknown ids, look-alike paths and other links alone", () => {
    const md = [
      "![gone](/api/v1/attachments/7/gone.png)",
      "[todo](/todos/5) and /api/v1/attachments/55/x and /api/v1/attachments/5x",
      "/api/v1/attachments/ alone, https://example.com/a.png",
    ].join("\n");
    expect(rewriteAttachmentLinks(md, files)).toBe(md);
  });

  it("names files by id plus a safe name", () => {
    expect(attachmentFileName({ id: 3, name: "a b/../c.txt" })).toBe("3-a-b-..-c.txt");
    expect(attachmentFileName({ id: 4, name: "" })).toBe("4-file");
  });

  it("builds sortable Markdown paths", () => {
    expect(markdownPath("people", 7, "Jürg Müller", "person")).toBe("people/0007-jurg-muller.md");
    expect(markdownPath("notes", 12345, "???", "note")).toBe("notes/12345-note.md");
    expect(markdownPath("todos", 1, "x".repeat(80), "todo")).toBe(`todos/0001-${"x".repeat(50)}.md`);
  });

  it("writes front matter that survives YAML-looking values", () => {
    const doc = markdownDocument({ title: "a: b", note: "---", list: ["x: 1"], none: null }, "Body\n\n\n");
    const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(doc);
    expect(parse(match?.[1] ?? "")).toEqual({ title: "a: b", note: "---", list: ["x: 1"], none: null });
    expect(match?.[2]).toBe("Body\n");
    expect(markdownDocument({ id: 1 }, "  \n")).toBe("---\nid: 1\n---\n\n");
  });

  it("formats comments with actor and local time, oldest first", () => {
    expect(commentsSection([], "Europe/Zurich")).toBe("");
    expect(
      commentsSection(
        [
          { actor: "you", bodyMd: "First **one**\n", createdAt: "2026-11-12T13:03:00.000Z" },
          { actor: "planner", bodyMd: "Second", createdAt: "2026-03-29T01:30:00.000Z" },
        ],
        "Europe/Zurich",
      ),
    ).toBe(
      "## Comments\n\n### you, 2026-11-12 14:03\n\nFirst **one**\n\n### planner, 2026-03-29 03:30\n\nSecond",
    );
  });
});
