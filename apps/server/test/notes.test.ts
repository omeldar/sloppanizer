import type { Note, NotePage } from "@organizer/shared";
import { describe, expect, it } from "vitest";
import { plainText } from "../src/services/text.ts";
import { json, makeApp, type TestApp } from "./helpers.ts";

const MIN = 60_000;
const note = (t: TestApp, body: Record<string, unknown>) => t.create<Note>("/api/v1/notes", body);
const list = async (t: TestApp, query = "") => json<NotePage>(await t.call("GET", `/api/v1/notes${query}`));
const titles = (page: NotePage) => page.items.map((n) => n.title);

describe("notes", () => {
  it("creates, reads, updates and deletes a note", async () => {
    const t = await makeApp();
    const home = await t.create<{ id: number }>("/api/v1/projects", { name: "Homelab" });
    const created = await note(t, {
      title: " Router setup ",
      bodyMd: "# Steps\n\n1. Flash **firmware**",
      projectId: home.id,
    });
    expect(created).toEqual({
      id: created.id,
      projectId: home.id,
      project: { id: home.id, slug: "homelab", name: "Homelab", color: "#8B95A5" },
      title: "Router setup",
      bodyMd: "# Steps\n\n1. Flash **firmware**",
      pinnedAt: null,
      createdBy: "you",
      createdAt: "2026-11-11T10:00:00.000Z",
      updatedAt: "2026-11-11T10:00:00.000Z",
    });
    expect(json<Note>(await t.call("GET", `/api/v1/notes/${created.id}`))).toEqual(created);
    t.advance(MIN);
    const updated = json<Note>(
      await t.call("PATCH", `/api/v1/notes/${created.id}`, { title: "Router", projectId: null }),
    );
    expect(updated).toMatchObject({
      title: "Router",
      projectId: null,
      project: null,
      updatedAt: "2026-11-11T10:01:00.000Z",
    });
    t.advance(MIN);
    const same = json<Note>(await t.call("PATCH", `/api/v1/notes/${created.id}`, { title: "Router" }));
    expect(same.updatedAt).toBe(updated.updatedAt);
    expect((await t.call("DELETE", `/api/v1/notes/${created.id}`)).statusCode).toBe(204);
    expect((await t.call("GET", `/api/v1/notes/${created.id}`)).statusCode).toBe(404);
    expect((await t.call("DELETE", `/api/v1/notes/${created.id}`)).statusCode).toBe(404);
  });

  it("validates input and the project", async () => {
    const t = await makeApp();
    expect((await t.call("POST", "/api/v1/notes", { title: "" })).statusCode).toBe(422);
    expect((await t.call("POST", "/api/v1/notes", { title: "x", projectId: 99 })).statusCode).toBe(422);
    const n = await note(t, { title: "x" });
    expect((await t.call("PATCH", `/api/v1/notes/${n.id}`, {})).statusCode).toBe(422);
    expect((await t.call("PATCH", `/api/v1/notes/${n.id}`, { projectId: 99 })).statusCode).toBe(422);
  });

  it("lists pinned notes first by pin time, then by last change, with excerpts", async () => {
    const t = await makeApp();
    const a = await note(t, { title: "A", bodyMd: "Some **bold** [link](https://x.ch) and `code`" });
    t.advance(MIN);
    const b = await note(t, { title: "B" });
    t.advance(MIN);
    const c = await note(t, { title: "C", pinned: true });
    t.advance(MIN);
    await t.call("PATCH", `/api/v1/notes/${a.id}`, { pinned: true });
    t.advance(MIN);
    await t.call("PATCH", `/api/v1/notes/${b.id}`, { bodyMd: "changed" });
    const page = await list(t);
    expect(titles(page)).toEqual(["A", "C", "B"]);
    expect(page.total).toBe(3);
    expect(page.items[0]?.excerpt).toBe("Some bold link and code");
    expect(page.items[0]).not.toHaveProperty("bodyMd");

    // Pinning again keeps the first pin time; unpinning clears it.
    const pinnedAt = json<Note>(await t.call("GET", `/api/v1/notes/${c.id}`)).pinnedAt;
    t.advance(MIN);
    expect(json<Note>(await t.call("PATCH", `/api/v1/notes/${c.id}`, { pinned: true })).pinnedAt).toBe(
      pinnedAt,
    );
    expect(json<Note>(await t.call("PATCH", `/api/v1/notes/${c.id}`, { pinned: false })).pinnedAt).toBeNull();
    expect(titles(await list(t))).toEqual(["A", "C", "B"]);
    expect(titles(await list(t, "?pinned=true"))).toEqual(["A"]);
    expect(titles(await list(t, "?pinned=false"))).toEqual(["C", "B"]);
  });

  it("filters by project, no project and title text, with paging", async () => {
    const t = await makeApp();
    const home = await t.create<{ id: number }>("/api/v1/projects", { name: "Homelab" });
    await note(t, { title: "Router 100%", projectId: home.id });
    t.advance(MIN);
    await note(t, { title: "Groceries" });
    t.advance(MIN);
    await note(t, { title: "router spare parts" });
    expect(titles(await list(t, `?projectId=${home.id}`))).toEqual(["Router 100%"]);
    expect(titles(await list(t, "?projectId=none"))).toEqual(["router spare parts", "Groceries"]);
    expect(titles(await list(t, "?q=ROUTER"))).toEqual(["router spare parts", "Router 100%"]);
    expect(titles(await list(t, "?q=100%25"))).toEqual(["Router 100%"]);
    expect(titles(await list(t, "?q=_"))).toEqual([]);
    const page = await list(t, "?limit=1&offset=1");
    expect(page).toMatchObject({ total: 3, limit: 1, offset: 1 });
    expect(titles(page)).toEqual(["Groceries"]);
  });

  it("moves notes to no project when their project is deleted", async () => {
    const t = await makeApp();
    const home = await t.create<{ id: number }>("/api/v1/projects", { name: "Homelab" });
    const n = await note(t, { title: "x", projectId: home.id });
    await t.call("DELETE", `/api/v1/projects/${home.id}`);
    expect(json<Note>(await t.call("GET", `/api/v1/notes/${n.id}`))).toMatchObject({
      projectId: null,
      project: null,
    });
  });

  it("records the token name as author", async () => {
    const t = await makeApp();
    const writer = t.token("assistant", "write");
    const res = await t.withToken(writer, "POST", "/api/v1/notes", { title: "From the token" });
    expect(res.json().createdBy).toBe("assistant");
    const reader = t.token("reader", "read");
    expect((await t.withToken(reader, "POST", "/api/v1/notes", { title: "x" })).statusCode).toBe(403);
    expect((await t.withToken(reader, "GET", "/api/v1/notes")).statusCode).toBe(200);
  });
});

describe("plainText", () => {
  it("drops Markdown syntax and keeps the words", () => {
    expect(
      plainText("# Title\n\n> quote\n- [x] done item\n* bullet\n2. second\n\n```ts\nconst a = 1;\n```"),
    ).toBe("Title quote done item bullet second const a = 1;");
    expect(plainText("![shot](/api/v1/attachments/3/shot.png) see ~~old~~ _new_")).toBe("shot see old new");
  });
});
