import type { Activity, NextUp, Space, Todo, TodoPage } from "@organizer/shared";
import type { InjectOptions } from "fastify";
import { describe, expect, it } from "vitest";
import { json, makeApp, type TestApp } from "./helpers.ts";

const H = "x-sloppanizer-space";

/** Anna owns "Home move" with Bo as a member; Cy is a user outside it. */
async function homeMove() {
  const t = await makeApp();
  const bo = await t.asAccount({ username: "bobo" });
  const cy = await t.asAccount({ username: "cyra" });
  const space = await t.create<Space>("/api/v1/spaces", { name: "Home move", members: ["bobo"] });
  const headers = { [H]: String(space.id) };
  const [project] = json<{ id: number }[]>(await t.call("GET", "/api/v1/projects", undefined, headers));
  const add = async (title: string, extra: Record<string, unknown> = {}) => {
    const res = await t.call("POST", "/api/v1/todos", { title, projectId: project?.id, ...extra }, headers);
    expect(res.statusCode).toBe(201);
    return json<Todo>(res);
  };
  return { t, bo, cy, space, headers, add };
}

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

describe("assignees in shared projects", () => {
  it("assigns members only, shows the assignee and records the change", async () => {
    const { t, bo, headers, add } = await homeMove();
    const todo = await add("Book van", { assignee: "bobo" });
    expect(todo.assignee).toEqual({ accountId: bo.account.id, username: "bobo", name: "bobo" });

    // Non-members and unknown names are refused with the same answer.
    const refused = await Promise.all(
      ["cyra", "nobody"].map((assignee) =>
        t.call("PATCH", `/api/v1/todos/${todo.id}`, { assignee }, headers),
      ),
    );
    expect(refused.map((r) => r.statusCode)).toEqual([422, 422]);
    expect(refused.map((r) => r.json().error.message)).toEqual([
      '"cyra" is not a member of this shared project. Assign one of its members.',
      '"nobody" is not a member of this shared project. Assign one of its members.',
    ]);
    // Usernames are trimmed and folded to lower case, like everywhere else.
    expect(
      (await t.call("PATCH", `/api/v1/todos/${todo.id}`, { assignee: "BOBO " }, headers)).statusCode,
    ).toBe(200);
    expect(
      (await t.call("POST", "/api/v1/todos", { title: "x", assignee: "cyra" }, headers)).statusCode,
    ).toBe(422);

    const moved = json<Todo>(
      await t.call("PATCH", `/api/v1/todos/${todo.id}`, { assignee: "anna" }, headers),
    );
    expect(moved.assignee?.username).toBe("anna");
    const cleared = json<Todo>(
      await t.call("PATCH", `/api/v1/todos/${todo.id}`, { assignee: null }, headers),
    );
    expect(cleared.assignee).toBeNull();

    const activity = json<Activity>(
      await t.call("GET", `/api/v1/todos/${todo.id}/activity`, undefined, headers),
    );
    const kinds = activity.items.flatMap((i) => (i.type === "event" ? [i.event] : []));
    expect(kinds.filter((e) => e.kind === "assignee_changed").map((e) => e.data)).toEqual([
      { from: { accountId: bo.account.id, name: "bobo" }, to: { accountId: t.account.id, name: "anna" } },
      { from: { accountId: t.account.id, name: "anna" }, to: null },
    ]);
  });

  it("refuses an assignee on personal todos", async () => {
    const t = await makeApp();
    const res = await t.call("POST", "/api/v1/todos", { title: "Mine", assignee: "anna" });
    expect(res.statusCode).toBe(422);
    const todo = await t.create<Todo>("/api/v1/todos", { title: "Mine" });
    expect(todo.assignee).toBeNull();
    expect((await t.call("PATCH", `/api/v1/todos/${todo.id}`, { assignee: "anna" })).statusCode).toBe(422);
    // Clearing is always fine (nothing changes).
    expect((await t.call("PATCH", `/api/v1/todos/${todo.id}`, { assignee: null })).statusCode).toBe(200);
  });

  it("filters by assignee: me, none, a username", async () => {
    const { t, bo, headers, add } = await homeMove();
    await add("Book van", { assignee: "bobo" });
    await add("Pack books", { assignee: "anna" });
    await add("Call landlord");
    const titles = async (actor: { call: TestApp["call"] }, query: string) =>
      json<TodoPage>(await actor.call("GET", `/api/v1/todos?${query}`, undefined, headers)).items.map(
        (i) => i.title,
      );
    expect(await titles(bo, "assignee=me")).toEqual(["Book van"]);
    expect(await titles(t, "assignee=me")).toEqual(["Pack books"]);
    expect(await titles(t, "assignee=none")).toEqual(["Call landlord"]);
    expect(await titles(t, "assignee=bobo")).toEqual(["Book van"]);
    expect(await titles(t, "assignee=nobody")).toEqual([]);
    const next = json<NextUp>(await bo.call("GET", "/api/v1/next?assignee=me", undefined, headers));
    expect(next.items.map((i) => i.todo.title)).toEqual(["Book van"]);
    // Personal todos are nobody's assignment.
    await t.create("/api/v1/todos", { title: "Own" });
    expect(json<TodoPage>(await t.call("GET", "/api/v1/todos?assignee=me")).items).toEqual([]);
  });

  it("takes a member off the project's todos when they leave or are removed", async () => {
    const { t, bo, headers, add } = await homeMove();
    const van = await add("Book van", { assignee: "bobo" });
    const books = await add("Pack books", { assignee: "anna" });
    expect(
      (await bo.call("DELETE", `/api/v1/spaces/${headers[H]}/members/${bo.account.id}`)).statusCode,
    ).toBe(204);
    const after = json<TodoPage>(await t.call("GET", "/api/v1/todos?status=all", undefined, headers));
    expect(after.items.find((i) => i.id === van.id)?.assignee).toBeNull();
    expect(after.items.find((i) => i.id === books.id)?.assignee?.username).toBe("anna");
    const activity = json<Activity>(
      await t.call("GET", `/api/v1/todos/${van.id}/activity`, undefined, headers),
    );
    const last = activity.items.at(-1);
    expect(last?.type === "event" && last.event).toMatchObject({
      kind: "assignee_changed",
      actor: "bobo",
      data: { from: { name: "bobo" }, to: null },
    });
    // A member added again starts with nothing assigned, and can be assigned again.
    expect(
      (await t.call("POST", `/api/v1/spaces/${headers[H]}/members`, { username: "bobo" })).statusCode,
    ).toBe(200);
    expect((await t.call("PATCH", `/api/v1/todos/${van.id}`, { assignee: "bobo" }, headers)).statusCode).toBe(
      200,
    );
  });

  it("keeps the assignee on the next todo of a repeat", async () => {
    const { t, headers, add } = await homeMove();
    const todo = await add("Water plants", {
      assignee: "bobo",
      dueOn: "2026-11-12",
      recurrence: { every: "week" },
    });
    const done = json<Todo>(await t.call("PATCH", `/api/v1/todos/${todo.id}`, { status: "done" }, headers));
    const next = json<Todo>(
      await t.call("GET", `/api/v1/todos/${done.nextOccurrence?.id}`, undefined, headers),
    );
    expect(next.assignee?.username).toBe("bobo");
  });

  it("lets admins be assigned in the Sloppanizer project, nobody else", async () => {
    const t = await makeApp();
    const root = await t.asAccount({ username: "root", role: "admin" });
    const { id } = json<{ id: number }>(
      await t.call("POST", "/api/v1/feedback", { kind: "bug", title: "Board drops cards" }),
    );
    const [space] = json<Space[]>(await root.call("GET", "/api/v1/spaces"));
    const headers = { [H]: String(space?.id) };
    expect((await root.call("PATCH", `/api/v1/todos/${id}`, { assignee: "anna" }, headers)).statusCode).toBe(
      422,
    );
    const todo = json<Todo>(await root.call("PATCH", `/api/v1/todos/${id}`, { assignee: "root" }, headers));
    expect(todo.assignee?.username).toBe("root");
  });
});

describe("shared projects and API tokens", () => {
  it("a member's token reads and (with write scope) changes the project, as the member", async () => {
    const { t, bo, headers, add } = await homeMove();
    const todo = await add("Book van");
    const read = bo.token("assistant", "read");
    const write = bo.token("planner", "write");

    const spaces = json<Space[]>(await withToken(t, read, "GET", "/api/v1/spaces"));
    expect(spaces.map((s) => s.name)).toEqual(["Home move"]);
    const page = await withToken(t, read, "GET", "/api/v1/todos", headers);
    expect(page.statusCode).toBe(200);
    expect(json<TodoPage>(page).items.map((i) => i.title)).toEqual(["Book van"]);
    // A read token reads only; the scope still decides inside a shared project.
    const denied = await withToken(t, read, "PATCH", `/api/v1/todos/${todo.id}`, headers, {
      assignee: "bobo",
    });
    expect(denied.statusCode).toBe(403);

    const changed = await withToken(t, write, "PATCH", `/api/v1/todos/${todo.id}`, headers, {
      assignee: "bobo",
    });
    expect(changed.statusCode).toBe(200);
    const activity = json<Activity>(
      await t.call("GET", `/api/v1/todos/${todo.id}/activity`, undefined, headers),
    );
    const last = activity.items.at(-1);
    expect(last?.type === "event" && last.event.actor).toBe("bobo via planner");

    // Managing the project stays with the browser session.
    expect((await withToken(t, write, "POST", "/api/v1/spaces", {}, { name: "Other" })).statusCode).toBe(403);
    expect(
      (await withToken(t, write, "DELETE", `/api/v1/spaces/${headers[H]}/members/${bo.account.id}`))
        .statusCode,
    ).toBe(403);
    // Personal routes stay personal with a token too.
    expect((await withToken(t, write, "GET", "/api/v1/settings", headers)).statusCode).toBe(403);
    expect((await withToken(t, write, "POST", "/api/v1/mcp", headers, {})).statusCode).toBe(403);
  });

  it("no path leaks todos of a project the caller is not a member of", async () => {
    const { t, cy, headers, add } = await homeMove();
    const todo = await add("Secret plan", { assignee: "bobo" });
    const session = (method: InjectOptions["method"], url: string, body?: unknown) =>
      cy.call(method, url, body, headers);
    const token = cy.token("assistant", "write");
    const viaToken = (method: InjectOptions["method"], url: string, body?: unknown) =>
      withToken(t, token, method, url, headers, body);

    const routes: [InjectOptions["method"], string, unknown?][] = [
      ["GET", "/api/v1/todos"],
      ["GET", "/api/v1/todos?assignee=bobo"],
      ["GET", `/api/v1/todos/${todo.id}`],
      ["GET", `/api/v1/todos/${todo.id}/activity`],
      ["GET", "/api/v1/next"],
      ["GET", "/api/v1/next?assignee=bobo"],
      ["GET", "/api/v1/search?q=secret"],
      ["GET", "/api/v1/stats"],
      ["GET", "/api/v1/projects"],
      ["PATCH", `/api/v1/todos/${todo.id}`, { assignee: "cyra" }],
      ["POST", "/api/v1/todos", { title: "Sneak in" }],
    ];
    for (const [method, url, body] of routes) {
      for (const run of [session, viaToken]) {
        // oxlint-disable-next-line no-await-in-loop -- one request after the other, each checked
        const res = await run(method, url, body);
        expect(res.statusCode, `${method} ${url}`).toBe(404);
        expect(res.body).not.toContain("Secret plan");
      }
    }
    // Without the header, the outsider only sees their own (empty) account.
    expect(json<TodoPage>(await cy.call("GET", "/api/v1/todos?assignee=bobo")).items).toEqual([]);
    expect(json<Space[]>(await withToken(t, token, "GET", "/api/v1/spaces"))).toEqual([]);
    expect((await withToken(t, token, "GET", `/api/v1/spaces/${headers[H]}`)).statusCode).toBe(404);
    // Nothing the outsider sent changed the todo.
    const unchanged = json<Todo>(await t.call("GET", `/api/v1/todos/${todo.id}`, undefined, headers));
    expect(unchanged.assignee?.username).toBe("bobo");
    expect(unchanged.title).toBe("Secret plan");
  });
});
