import type { Comment, Note, Person, RestorePreview, SearchResult, Todo } from "@organizer/shared";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { json, makeApp, type TestApp } from "./helpers.ts";

const search = async (t: TestApp, text: string) =>
  json<SearchResult>(await t.call("GET", `/api/v1/search?q=${encodeURIComponent(text)}`));
const count = async (t: TestApp, text: string, kind: keyof SearchResult["counts"]) =>
  (await search(t, text)).counts[kind];

describe("search index stays in step with every kind of change", () => {
  it("follows comment edits and deletes", async () => {
    const t = await makeApp();
    const todo = await t.create<Todo>("/api/v1/todos", { title: "Plain title" });
    const c = await t.create<Comment>(`/api/v1/todos/${todo.id}/comments`, { bodyMd: "zebrafinch sighted" });
    expect(await count(t, "zebrafinch", "comment")).toBe(1);
    await t.call("PATCH", `/api/v1/comments/${c.id}`, { bodyMd: "flamingo sighted" });
    expect(await count(t, "zebrafinch", "comment")).toBe(0);
    expect(await count(t, "flamingo", "comment")).toBe(1);
    await t.call("DELETE", `/api/v1/comments/${c.id}`);
    expect(await count(t, "flamingo", "comment")).toBe(0);
  });

  it("follows note edits, appends and project moves, and person renames", async () => {
    const t = await makeApp();
    const note = await t.create<Note>("/api/v1/notes", { title: "Log", bodyMd: "alpacas" });
    await t.call("PATCH", `/api/v1/notes/${note.id}`, { appendMd: "llamas" });
    expect(await count(t, "alpacas", "note")).toBe(1);
    expect(await count(t, "llamas", "note")).toBe(1);
    await t.call("PATCH", `/api/v1/notes/${note.id}`, { bodyMd: "vicunas", title: "Camelids" });
    expect(await count(t, "alpacas", "note")).toBe(0);
    expect(await count(t, "camelids", "note")).toBe(1);

    const p = await t.create<Person>("/api/v1/people", { firstName: "Ursula", lastName: "Keller" });
    await t.call("PATCH", `/api/v1/people/${p.id}`, { lastName: "Brunner", email: "u@example.org" });
    expect(await count(t, "keller", "person")).toBe(0);
    expect(await count(t, "brunner", "person")).toBe(1);
    expect(await count(t, "example.org", "person")).toBe(1);
  });

  it("drops a todo's comments and the todo from the index when the todo is deleted", async () => {
    const t = await makeApp();
    const todo = await t.create<Todo>("/api/v1/todos", { title: "Narwhals" });
    await t.create(`/api/v1/todos/${todo.id}/comments`, { bodyMd: "narwhal tusk" });
    await t.call("DELETE", `/api/v1/todos/${todo.id}`);
    const res = await search(t, "narwhal");
    expect(res.items).toEqual([]);
    expect(res.counts).toMatchObject({ todo: 0, comment: 0 });
  });

  it("answers an empty or one-letter query without a server error", async () => {
    const t = await makeApp();
    await t.create("/api/v1/todos", { title: "Xylophone" });
    const codes = await Promise.all(
      ["", " ", "x"].map(
        async (text) => (await t.call("GET", `/api/v1/search?q=${encodeURIComponent(text)}`)).statusCode,
      ),
    );
    expect(codes.every((code) => code === 200 || code === 422)).toBe(true);
    expect(await count(t, "x", "todo")).toBe(1);
  });
});

const stage = async (t: TestApp): Promise<RestorePreview> => {
  const zip = (await t.call("GET", "/api/v1/export.zip")).rawPayload;
  const res = await t.call("POST", "/api/v1/restore?name=a.zip", zip, {
    "content-type": "application/zip",
  });
  expect(res.statusCode).toBe(201);
  return json<RestorePreview>(res);
};

describe("restore guards", () => {
  it("refuses to apply without the typed confirmation and leaves data and upload alone", async () => {
    const t = await makeApp();
    const todo = await t.create<Todo>("/api/v1/todos", { title: "Keep me" });
    const preview = await stage(t);
    const codes = await Promise.all(
      [undefined, {}, { confirm: "yes" }, { confirm: "REPLACE" }].map(
        async (body) => (await t.call("POST", `/api/v1/restore/${preview.uploadId}/apply`, body)).statusCode,
      ),
    );
    expect(codes).toEqual([422, 422, 422, 422]);
    expect((await t.call("GET", `/api/v1/todos/${todo.id}`)).statusCode).toBe(200);
    expect((await t.call("GET", `/api/v1/restore/${preview.uploadId}`)).statusCode).toBe(200);
    expect(json<unknown[]>(await t.call("GET", "/api/v1/restore/backups"))).toEqual([]);
  });

  it("uses an upload once: a second apply and an unknown or malformed id answer 404", async () => {
    const t = await makeApp();
    const preview = await stage(t);
    const apply = (id: string) => t.call("POST", `/api/v1/restore/${id}/apply`, { confirm: "replace" });
    expect((await apply(preview.uploadId)).statusCode).toBe(200);
    expect((await apply(preview.uploadId)).statusCode).toBe(404);
    expect((await apply("f".repeat(32))).statusCode).toBe(404);
    const codes = await Promise.all(
      ["short", "..", "g".repeat(32)].map(async (id) => (await apply(id)).statusCode),
    );
    expect(codes.every((code) => code === 404 || code === 422)).toBe(true);
  });

  it("keeps the ids of deleted rows unused after a restore (sequences are restored)", async () => {
    const t = await makeApp();
    const a = await t.create<Todo>("/api/v1/todos", { title: "A" });
    const b = await t.create<Todo>("/api/v1/todos", { title: "B" });
    await t.call("DELETE", `/api/v1/todos/${b.id}`);
    const preview = await stage(t);
    await t.call("POST", `/api/v1/restore/${preview.uploadId}/apply`, { confirm: "replace" });
    const c = await t.create<Todo>("/api/v1/todos", { title: "C" });
    expect(c.id).toBeGreaterThan(b.id);
    expect(a.id).toBeLessThan(b.id);
  });
});

describe("folder export retention", () => {
  it("prunes only its own zips and leaves other files in the folder alone", async () => {
    const t = await makeApp();
    await t.call("POST", "/api/v1/export/folder");
    const dir = join(t.dataDir, "exports");
    mkdirSync(dir, { recursive: true });
    const foreign = ["notes.txt", "my-backup.zip", "organizer-export-manual.zip"];
    for (const name of foreign) writeFileSync(join(dir, name), "mine");
    for (let i = 0; i < 6; i += 1) {
      t.advance(1000);
      // oxlint-disable-next-line no-await-in-loop -- one export after the other
      await t.call("POST", "/api/v1/export/folder");
    }
    const left = readdirSync(dir);
    expect(left).toEqual(expect.arrayContaining(foreign));
    expect(left.filter((n) => /^organizer-export-\d{8}-\d{6}/.test(n))).toHaveLength(4);
  });
});

describe("comment ownership by token id", () => {
  it("keeps the comments of a revoked token from a new token with the same name", async () => {
    // Ownership is the token id, not its name: a revoked token's name can be reused, and the new token
    // must not take over the old comments. Only the session may change them now.
    const t = await makeApp();
    const todo = await t.create<Todo>("/api/v1/todos", { title: "T" });
    const first = await t.create<{ raw: string; token: { id: number } }>("/api/v1/tokens", {
      name: "bot",
      scope: "write",
    });
    const mine = json<Comment>(
      await t.withToken(first.raw, "POST", `/api/v1/todos/${todo.id}/comments`, { bodyMd: "old" }),
    );
    expect(mine.actor).toBe("bot");
    expect(
      (await t.withToken(first.raw, "PATCH", `/api/v1/comments/${mine.id}`, { bodyMd: "edited" })).statusCode,
    ).toBe(200);
    await t.call("DELETE", `/api/v1/tokens/${first.token.id}`);
    const second = await t.create<{ raw: string }>("/api/v1/tokens", { name: "bot", scope: "write" });
    const other = t.token("other", "write");
    expect(
      (await t.withToken(other, "PATCH", `/api/v1/comments/${mine.id}`, { bodyMd: "x" })).statusCode,
    ).toBe(403);
    expect(
      (await t.withToken(first.raw, "PATCH", `/api/v1/comments/${mine.id}`, { bodyMd: "x" })).statusCode,
    ).toBe(401);
    const takeover = await t.withToken(second.raw, "PATCH", `/api/v1/comments/${mine.id}`, { bodyMd: "x" });
    expect(takeover.statusCode).toBe(403);
    expect((await t.withToken(second.raw, "DELETE", `/api/v1/comments/${mine.id}`)).statusCode).toBe(403);
    // The new token owns what it writes itself; the session may change any comment.
    const own = json<Comment>(
      await t.withToken(second.raw, "POST", `/api/v1/todos/${todo.id}/comments`, { bodyMd: "new" }),
    );
    expect(
      (await t.withToken(second.raw, "PATCH", `/api/v1/comments/${own.id}`, { bodyMd: "new 2" })).statusCode,
    ).toBe(200);
    expect((await t.call("PATCH", `/api/v1/comments/${mine.id}`, { bodyMd: "by you" })).statusCode).toBe(200);
    expect(
      json<Comment[]>(await t.call("GET", `/api/v1/todos/${todo.id}/comments`)).map((c) => c.actor),
    ).toEqual(["bot", "bot"]);
  });

  it("never lets a token change a comment of the session", async () => {
    const t = await makeApp();
    const todo = await t.create<Todo>("/api/v1/todos", { title: "T" });
    const c = await t.create<Comment>(`/api/v1/todos/${todo.id}/comments`, { bodyMd: "mine" });
    const raw = t.token("helper", "write");
    expect((await t.withToken(raw, "PATCH", `/api/v1/comments/${c.id}`, { bodyMd: "x" })).statusCode).toBe(
      403,
    );
  });

  it("links restored token comments to the token of this device that wrote them, never to a newer namesake", async () => {
    const t = await makeApp();
    const todo = await t.create<Todo>("/api/v1/todos", { title: "T" });
    const bot = await t.create<{ raw: string; token: { id: number } }>("/api/v1/tokens", {
      name: "bot",
      scope: "write",
    });
    t.advance(1000);
    const byBot = json<Comment>(
      await t.withToken(bot.raw, "POST", `/api/v1/todos/${todo.id}/comments`, { bodyMd: "by bot" }),
    );
    const zip = (await t.call("GET", "/api/v1/export.zip")).rawPayload;
    const restore = async () => {
      const preview = json<RestorePreview>(
        await t.call("POST", "/api/v1/restore?name=x.zip", zip, { "content-type": "application/zip" }),
      );
      const res = await t.call("POST", `/api/v1/restore/${preview.uploadId}/apply`, { confirm: "replace" });
      expect(res.statusCode).toBe(200);
    };
    const patchAs = async (raw: string) =>
      (await t.withToken(raw, "PATCH", `/api/v1/comments/${byBot.id}`, { bodyMd: `edit ${raw.slice(-4)}` }))
        .statusCode;

    // Same device, token still active: it owns its comment again.
    t.advance(1000);
    await restore();
    expect(await patchAs(bot.raw)).toBe(200);

    // The token is revoked and a new "bot" is made after the comment was written: no takeover.
    t.advance(1000);
    await t.call("DELETE", `/api/v1/tokens/${bot.token.id}`);
    const newer = await t.create<{ raw: string }>("/api/v1/tokens", { name: "bot", scope: "write" });
    t.advance(1000);
    await restore();
    expect(await patchAs(newer.raw)).toBe(403);
    expect((await t.call("PATCH", `/api/v1/comments/${byBot.id}`, { bodyMd: "by you" })).statusCode).toBe(
      200,
    );
  });
});
