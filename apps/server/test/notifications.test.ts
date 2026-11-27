import type { Activity, NotificationList, Space, Todo, TodoPage } from "@organizer/shared";
import type { InjectOptions } from "fastify";
import { describe, expect, it } from "vitest";
import { json, makeApp, type TestActor, type TestApp } from "./helpers.ts";

const H = "x-sloppanizer-space";

/** Anna owns "Home move" with Bo and Cy as members. */
async function homeMove() {
  const t = await makeApp();
  const bo = await t.asAccount({ username: "bobo" });
  const cy = await t.asAccount({ username: "cyra" });
  const space = await t.create<Space>("/api/v1/spaces", { name: "Home move", members: ["bobo", "cyra"] });
  const headers = { [H]: String(space.id) };
  const add = async (title: string, extra: Record<string, unknown> = {}) => {
    const res = await t.call("POST", "/api/v1/todos", { title, ...extra }, headers);
    expect(res.statusCode).toBe(201);
    return json<Todo>(res);
  };
  return { t, bo, cy, space, headers, add };
}

const inbox = async (who: Pick<TestActor, "call">) =>
  json<NotificationList>(await who.call("GET", "/api/v1/notifications"));

const lines = (list: NotificationList) =>
  list.items.map((n) => `${n.kind} ${n.todo.ref} ${n.actor}${n.excerpt ? `: ${n.excerpt}` : ""}`);

/** A call with a bearer token and optional extra headers. */
const withToken = (
  t: TestApp,
  raw: string,
  method: InjectOptions["method"],
  url: string,
  headers: Record<string, string> = {},
  body?: unknown,
) =>
  t.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${raw}`, ...headers },
    ...(body === undefined ? {} : { payload: body as InjectOptions["payload"] }),
  });

describe("action needed", () => {
  it("is set with a reason, shows on the todo, is filtered, and removed with null", async () => {
    const t = await makeApp();
    const todo = await t.create<Todo>("/api/v1/todos", { title: "Renew the certificate" });
    expect(todo.actionNeeded).toBeNull();
    const token = t.token("assistant", "write");
    const flagged = await withToken(
      t,
      token,
      "PATCH",
      `/api/v1/todos/${todo.id}`,
      {},
      {
        actionNeeded: "  Approve the DNS change in the Vercel dashboard ",
      },
    );
    expect(flagged.statusCode).toBe(200);
    expect(json<Todo>(flagged).actionNeeded).toEqual({
      reason: "Approve the DNS change in the Vercel dashboard",
      by: "assistant",
      at: "2026-11-11T10:00:00.000Z",
    });
    await t.create<Todo>("/api/v1/todos", { title: "Other" });
    const only = json<TodoPage>(await t.call("GET", "/api/v1/todos?actionNeeded=true"));
    expect(only.items.map((i) => i.title)).toEqual(["Renew the certificate"]);
    const without = json<TodoPage>(await t.call("GET", "/api/v1/todos?actionNeeded=false"));
    expect(without.items.map((i) => i.title)).toEqual(["Other"]);

    const cleared = json<Todo>(await t.call("PATCH", `/api/v1/todos/${todo.id}`, { actionNeeded: null }));
    expect(cleared.actionNeeded).toBeNull();
    const activity = json<Activity>(await t.call("GET", `/api/v1/todos/${todo.id}/activity`));
    expect(
      activity.items
        .flatMap((i) => (i.type === "event" && i.event.kind === "action_needed_changed" ? [i.event] : []))
        .map((e) => [e.actor, e.data]),
    ).toEqual([
      ["assistant", { from: null, to: "Approve the DNS change in the Vercel dashboard" }],
      ["you", { from: "Approve the DNS change in the Vercel dashboard", to: null }],
    ]);
    // A marker without a reason is a marker too; too long a reason is refused.
    const bare = json<Todo>(await t.call("PATCH", `/api/v1/todos/${todo.id}`, { actionNeeded: "" }));
    expect(bare.actionNeeded?.reason).toBe("");
    expect(
      (await t.call("PATCH", `/api/v1/todos/${todo.id}`, { actionNeeded: "x".repeat(501) })).statusCode,
    ).toBe(422);
    const created = await t.create<Todo>("/api/v1/todos", { title: "Sign", actionNeeded: "Sign the form" });
    expect(created.actionNeeded?.reason).toBe("Sign the form");
  });

  it("notifies the owner of an own todo when a token marks it, not when they do it themselves", async () => {
    const t = await makeApp();
    const todo = await t.create<Todo>("/api/v1/todos", { title: "Renew" });
    await t.call("PATCH", `/api/v1/todos/${todo.id}`, { actionNeeded: "Mine" });
    expect((await inbox(t)).items).toEqual([]);
    const token = t.token("assistant", "write");
    await withToken(t, token, "PATCH", `/api/v1/todos/${todo.id}`, {}, { actionNeeded: "Approve it" });
    const list = await inbox(t);
    expect(lines(list)).toEqual([`action_needed #${todo.id} assistant: Approve it`]);
    expect(list.unreadCount).toBe(1);
    expect(list.items[0]).toMatchObject({
      space: null,
      readAt: null,
      todo: { title: "Renew", status: "open" },
    });
    // The same reason again is no news.
    await withToken(t, token, "PATCH", `/api/v1/todos/${todo.id}`, {}, { actionNeeded: "Approve it" });
    expect((await inbox(t)).items).toHaveLength(1);
  });
});

describe("notifications in shared projects", () => {
  it("tells a member they were assigned, never the one who assigned themselves", async () => {
    const { t, bo, space, headers, add } = await homeMove();
    const todo = await add("Book the van", { assignee: "bobo" });
    await t.call("PATCH", `/api/v1/todos/${todo.id}`, { assignee: "anna" }, headers);
    expect(lines(await inbox(bo))).toEqual([`assigned S${space.id}#${todo.id} anna`]);
    expect((await inbox(bo)).items[0]?.space).toEqual({ id: space.id, name: "Home move" });
    expect((await inbox(t)).items).toEqual([]);
  });

  it("tells mentioned members and the assignee about a comment, once each", async () => {
    const { t, bo, cy, space, headers, add } = await homeMove();
    const todo = await add("Book the van", { assignee: "bobo" });
    await bo.call("GET", "/api/v1/notifications");
    await bo.call("POST", "/api/v1/notifications/read", { all: true });
    const res = await t.call(
      "POST",
      `/api/v1/todos/${todo.id}/comments`,
      { bodyMd: "**@cyra** can you check the price? @bobo too. Mail me at anna@example.com." },
      headers,
    );
    expect(res.statusCode).toBe(201);
    const ref = `S${space.id}#${todo.id}`;
    const excerpt = "@cyra can you check the price? @bobo too. Mail me at anna@example.com.";
    expect(lines(await inbox(cy))).toEqual([`mentioned ${ref} anna: ${excerpt}`]);
    expect(lines(await inbox(bo))).toEqual([`mentioned ${ref} anna: ${excerpt}`, `assigned ${ref} anna`]);
    // A comment without mentions tells the assignee only.
    await cy.call("POST", `/api/v1/todos/${todo.id}/comments`, { bodyMd: "Done." }, headers);
    expect(lines(await inbox(bo))[0]).toBe(`commented ${ref} cyra: Done.`);
    expect((await inbox(t)).items).toEqual([]);
  });

  it("tells every member about an unassigned todo marked action needed, also the token's owner", async () => {
    const { t, bo, cy, space, headers, add } = await homeMove();
    const todo = await add("Pick a date");
    const token = bo.token("assistant", "write");
    await withToken(t, token, "PATCH", `/api/v1/todos/${todo.id}`, headers, {
      actionNeeded: "Say which day",
    });
    const ref = `S${space.id}#${todo.id}`;
    const all = await Promise.all([t, bo, cy].map((who) => inbox(who)));
    for (const list of all)
      expect(lines(list)).toEqual([`action_needed ${ref} bobo via assistant: Say which day`]);
  });

  it("marks read and unread, and only the caller's own", async () => {
    const { t, bo, cy, add } = await homeMove();
    const first = await add("One", { assignee: "bobo" });
    await add("Two", { assignee: "bobo" });
    await add("Three", { assignee: "cyra" });
    const list = await inbox(bo);
    expect(list.unreadCount).toBe(2);
    const cyId = (await inbox(cy)).items[0]?.id as number;
    const firstId = list.items.find((n) => n.todo.id === first.id)?.id as number;
    const after = json<NotificationList>(
      await bo.call("POST", "/api/v1/notifications/read", { ids: [firstId, cyId] }),
    );
    expect(after.unreadCount).toBe(1);
    expect((await inbox(cy)).unreadCount).toBe(1);
    expect(
      json<NotificationList>(await bo.call("GET", "/api/v1/notifications?unread=true")).items,
    ).toHaveLength(1);
    await bo.call("POST", "/api/v1/notifications/read", { all: true });
    expect((await inbox(bo)).unreadCount).toBe(0);
    await bo.call("POST", "/api/v1/notifications/read", { ids: [firstId], read: false });
    expect((await inbox(bo)).unreadCount).toBe(1);
    expect((await bo.call("POST", "/api/v1/notifications/read", {})).statusCode).toBe(422);
    // Inside a shared project there is no inbox of the project.
    expect((await t.call("GET", "/api/v1/notifications", undefined, { [H]: "1" })).statusCode).toBe(403);
  });

  it("drops notifications of a deleted todo and of a project the member left", async () => {
    const { t, bo, space, headers, add } = await homeMove();
    const gone = await add("Gone", { assignee: "bobo" });
    await add("Stays", { assignee: "bobo" });
    await t.call("DELETE", `/api/v1/todos/${gone.id}`, undefined, headers);
    expect((await inbox(bo)).items.map((n) => n.todo.title)).toEqual(["Stays"]);
    const bobo = (await t.call("GET", `/api/v1/spaces/${space.id}`))
      .json()
      .members.find((m: { username: string }) => m.username === "bobo");
    expect((await t.call("DELETE", `/api/v1/spaces/${space.id}/members/${bobo.accountId}`)).statusCode).toBe(
      204,
    );
    expect((await inbox(bo)).items).toEqual([]);
  });
});
