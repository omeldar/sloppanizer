import type { Activity, Comment, Todo } from "@organizer/shared";
import { describe, expect, it } from "vitest";
import { events } from "../src/db/schema.ts";
import { insertOwnedRow } from "../src/services/owned.ts";
import { json, makeApp, type TestApp } from "./helpers.ts";

const MIN = 60_000;
const createTodo = (t: TestApp, body: Record<string, unknown> = {}) =>
  t.create<Todo>("/api/v1/todos", { title: "Renew certs", ...body });
const comment = (t: TestApp, todoId: number, bodyMd: string) =>
  t.create<Comment>(`/api/v1/todos/${todoId}/comments`, { bodyMd });
const activity = async (t: TestApp, todoId: number) =>
  json<Activity>(await t.call("GET", `/api/v1/todos/${todoId}/activity`));
const describeItems = (a: Activity) =>
  a.items.map((i) => (i.type === "comment" ? `comment:${i.comment.bodyMd}` : `event:${i.event.kind}`));
const descriptionEvents = (t: TestApp) =>
  t.deps.db
    .select()
    .from(events)
    .all()
    .filter((e) => e.kind === "description_changed")
    .map((e) =>
      Object.assign(JSON.parse(e.data) as { from: string; to: string }, {
        actor: e.actor,
        createdAt: e.createdAt,
      }),
    );

describe("comments", () => {
  it("creates, lists, edits and deletes comments; adding moves last activity only", async () => {
    const t = await makeApp();
    const todo = await createTodo(t);
    t.advance(5 * MIN);
    const c = await comment(t, todo.id, "Asked **Max**.");
    expect(c).toEqual({
      id: c.id,
      todoId: todo.id,
      actor: "you",
      bodyMd: "Asked **Max**.",
      createdAt: "2026-11-11T10:05:00.000Z",
      updatedAt: "2026-11-11T10:05:00.000Z",
      editedAt: null,
    });
    const after = json<Todo>(await t.call("GET", `/api/v1/todos/${todo.id}`));
    expect(after.lastActivityAt).toBe("2026-11-11T10:05:00.000Z");
    expect(after.updatedAt).toBe(todo.updatedAt);
    expect(after.commentCount).toBe(1);

    t.advance(MIN);
    const edited = json<Comment>(await t.call("PATCH", `/api/v1/comments/${c.id}`, { bodyMd: "Asked Max." }));
    expect(edited).toMatchObject({
      bodyMd: "Asked Max.",
      createdAt: c.createdAt,
      updatedAt: "2026-11-11T10:06:00.000Z",
      editedAt: "2026-11-11T10:06:00.000Z",
    });
    expect(json<Comment[]>(await t.call("GET", `/api/v1/todos/${todo.id}/comments`))).toEqual([edited]);
    expect((await t.call("DELETE", `/api/v1/comments/${c.id}`)).statusCode).toBe(204);
    expect(json<Comment[]>(await t.call("GET", `/api/v1/todos/${todo.id}/comments`))).toEqual([]);
    expect((await t.call("DELETE", `/api/v1/comments/${c.id}`)).statusCode).toBe(404);
    expect((await t.call("PATCH", `/api/v1/comments/${c.id}`, { bodyMd: "x" })).statusCode).toBe(404);
  });

  it("validates bodies and answers 404 for unknown todos", async () => {
    const t = await makeApp();
    const todo = await createTodo(t);
    expect((await t.call("POST", `/api/v1/todos/${todo.id}/comments`, { bodyMd: "  " })).statusCode).toBe(
      422,
    );
    expect(
      (await t.call("POST", `/api/v1/todos/${todo.id}/comments`, { bodyMd: "x".repeat(50_001) })).statusCode,
    ).toBe(422);
    expect((await t.call("POST", "/api/v1/todos/999/comments", { bodyMd: "x" })).statusCode).toBe(404);
    expect((await t.call("GET", "/api/v1/todos/999/comments")).statusCode).toBe(404);
    expect((await t.call("GET", "/api/v1/todos/999/activity")).statusCode).toBe(404);
  });

  it("lets a token change only its own comments, the session any, a read token none", async () => {
    const t = await makeApp();
    const todo = await createTodo(t);
    const assistant = t.token("assistant", "write");
    const other = t.token("other", "write");
    const reader = t.token("reader", "read");
    const mine = json<Comment>(
      await t.withToken(assistant, "POST", `/api/v1/todos/${todo.id}/comments`, { bodyMd: "From the token" }),
    );
    expect(mine.actor).toBe("assistant");
    const byYou = await comment(t, todo.id, "From the browser");

    const denied = await t.withToken(assistant, "PATCH", `/api/v1/comments/${byYou.id}`, {
      bodyMd: "changed",
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toBe(
      "This comment was written by you; a token can only change its own comments.",
    );
    expect((await t.withToken(other, "DELETE", `/api/v1/comments/${mine.id}`)).statusCode).toBe(403);
    expect((await t.withToken(reader, "GET", `/api/v1/todos/${todo.id}/comments`)).statusCode).toBe(200);
    expect(
      (await t.withToken(reader, "POST", `/api/v1/todos/${todo.id}/comments`, { bodyMd: "x" })).statusCode,
    ).toBe(403);
    expect(
      (await t.withToken(assistant, "PATCH", `/api/v1/comments/${mine.id}`, { bodyMd: "edited" })).statusCode,
    ).toBe(200);
    expect(
      (await t.call("PATCH", `/api/v1/comments/${mine.id}`, { bodyMd: "the session may" })).statusCode,
    ).toBe(200);
    expect((await t.call("DELETE", `/api/v1/comments/${mine.id}`)).statusCode).toBe(204);
    expect((await t.withToken(assistant, "DELETE", `/api/v1/comments/${byYou.id}`)).statusCode).toBe(403);
    // Unknown ids stay 404 for tokens too (no 403 that tells them the comment exists elsewhere).
    expect((await t.withToken(assistant, "DELETE", "/api/v1/comments/999")).statusCode).toBe(404);
  });

  it("goes away with its todo", async () => {
    const t = await makeApp();
    const todo = await createTodo(t);
    const c = await comment(t, todo.id, "x");
    await t.call("DELETE", `/api/v1/todos/${todo.id}`);
    expect((await t.call("PATCH", `/api/v1/comments/${c.id}`, { bodyMd: "y" })).statusCode).toBe(404);
  });
});

describe("activity thread", () => {
  it("merges events and comments oldest first, events before comments at the same time", async () => {
    const t = await makeApp();
    const todo = await createTodo(t);
    await comment(t, todo.id, "same time as created");
    t.advance(MIN);
    await t.call("PATCH", `/api/v1/todos/${todo.id}`, { status: "done" });
    t.advance(MIN);
    await comment(t, todo.id, "later");
    const a = await activity(t, todo.id);
    expect(a.todoId).toBe(todo.id);
    expect(describeItems(a)).toEqual([
      "event:created",
      "comment:same time as created",
      "event:status_changed",
      "comment:later",
    ]);
    const status = a.items[2];
    expect(status?.type === "event" && status.event).toMatchObject({
      actor: "you",
      data: { from: "open", to: "done" },
      createdAt: "2026-11-11T10:01:00.000Z",
    });
  });

  it("normalizes descriptions, projects (also deleted ones) and old people events", async () => {
    const t = await makeApp();
    const home = await t.create<{ id: number }>("/api/v1/projects", { name: "Homelab" });
    const todo = await createTodo(t, { descriptionMd: "abc" });
    await t.call("PATCH", `/api/v1/todos/${todo.id}`, { descriptionMd: "abcdef", projectId: home.id });
    await t.call("DELETE", `/api/v1/projects/${home.id}`);
    // An event as step 1 wrote it (no role).
    insertOwnedRow(t.ctx(), events, {
      todoId: todo.id,
      actor: "you",
      kind: "people_changed",
      data: JSON.stringify({ from: [], to: [{ id: 1, name: "Anna Meier" }] }),
      createdAt: "2026-11-11T10:00:00.000Z",
    });
    const data = (await activity(t, todo.id)).items
      .filter((i) => i.type === "event")
      .map((i) => (i.type === "event" ? [i.event.kind, i.event.data] : []));
    expect(data).toContainEqual(["description_changed", { fromChars: 3, toChars: 6 }]);
    expect(data).toContainEqual(["project_changed", { from: null, to: { id: home.id, name: null } }]);
    expect(data).toContainEqual(["project_changed", { from: { id: home.id, name: null }, to: null }]);
    expect(data).toContainEqual([
      "people_changed",
      { role: "requester", from: [], to: [{ id: 1, name: "Anna Meier" }] },
    ]);
    // No full description text anywhere in the thread.
    expect(JSON.stringify(data)).not.toContain("abcdef");
  });

  it("names existing projects in project changes", async () => {
    const t = await makeApp();
    const home = await t.create<{ id: number }>("/api/v1/projects", { name: "Homelab" });
    const todo = await createTodo(t);
    await t.call("PATCH", `/api/v1/todos/${todo.id}`, { projectId: home.id });
    const last = (await activity(t, todo.id)).items.at(-1);
    expect(last?.type === "event" && last.event.data).toEqual({
      from: null,
      to: { id: home.id, name: "Homelab" },
    });
  });
});

describe("description edits merge into one history entry", () => {
  it("merges edits by the same actor within 10 minutes", async () => {
    const t = await makeApp();
    const todo = await createTodo(t, { descriptionMd: "v0" });
    const edit = (text: string) => t.call("PATCH", `/api/v1/todos/${todo.id}`, { descriptionMd: text });
    await edit("v1");
    t.advance(4 * MIN);
    await edit("v2");
    t.advance(9 * MIN);
    const res = await edit("v3");
    expect(json<Todo>(res).lastActivityAt).toBe("2026-11-11T10:13:00.000Z");
    expect(descriptionEvents(t)).toEqual([
      { from: "v0", to: "v3", actor: "you", createdAt: "2026-11-11T10:13:00.000Z" },
    ]);
  });

  it("starts a new entry after 10 minutes, for another actor, or after another event", async () => {
    const t = await makeApp();
    const todo = await createTodo(t, { descriptionMd: "v0" });
    const edit = (text: string) => t.call("PATCH", `/api/v1/todos/${todo.id}`, { descriptionMd: text });
    await edit("v1");
    t.advance(10 * MIN + 1);
    await edit("v2");
    const writer = t.token("assistant", "write");
    await t.withToken(writer, "PATCH", `/api/v1/todos/${todo.id}`, { descriptionMd: "v3" });
    await edit("v4");
    await t.call("PATCH", `/api/v1/todos/${todo.id}`, { title: "Renamed" });
    await edit("v5");
    expect(descriptionEvents(t).map((e) => `${e.actor}:${e.from}>${e.to}`)).toEqual([
      "you:v0>v1",
      "you:v1>v2",
      "assistant:v2>v3",
      "you:v3>v4",
      "you:v4>v5",
    ]);
  });

  it("deletes the entry when the text is back to where it started", async () => {
    const t = await makeApp();
    const todo = await createTodo(t, { descriptionMd: "original" });
    const edit = (text: string) => t.call("PATCH", `/api/v1/todos/${todo.id}`, { descriptionMd: text });
    await edit("typo");
    t.advance(MIN);
    await edit("original");
    expect(descriptionEvents(t)).toEqual([]);
    expect(json<Todo>(await t.call("GET", `/api/v1/todos/${todo.id}`)).descriptionMd).toBe("original");
  });

  it("does not count comments as events in between", async () => {
    const t = await makeApp();
    const todo = await createTodo(t, { descriptionMd: "v0" });
    await t.call("PATCH", `/api/v1/todos/${todo.id}`, { descriptionMd: "v1" });
    await comment(t, todo.id, "note");
    await t.call("PATCH", `/api/v1/todos/${todo.id}`, { descriptionMd: "v2" });
    expect(descriptionEvents(t).map((e) => `${e.from}>${e.to}`)).toEqual(["v0>v2"]);
  });
});
