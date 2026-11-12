import type { Activity, ActivityEvent, Project, Todo } from "@organizer/shared";
import { describe, expect, it } from "vitest";
import { json, makeApp, type TestApp } from "./helpers.ts";

const events = async (t: TestApp, id: number, kind?: string): Promise<ActivityEvent[]> =>
  json<Activity>(await t.call("GET", `/api/v1/todos/${id}/activity`))
    .items.flatMap((item) => (item.type === "event" ? [item.event] : []))
    .filter((e) => kind === undefined || e.kind === kind);

const getTodo = async (t: TestApp, id: number) => json<Todo>(await t.call("GET", `/api/v1/todos/${id}`));

describe("subtasks", () => {
  it("creates children in order after the last child, in the parent's project, with one event", async () => {
    const t = await makeApp();
    const project = await t.create<Project>("/api/v1/projects", { name: "Home" });
    const parent = await t.create<Todo>("/api/v1/todos", { title: "Move", projectId: project.id });
    t.advance(60_000);
    const first = await t.call("POST", `/api/v1/todos/${parent.id}/subtasks`, { titles: ["Pack", "Drive"] });
    expect(first.statusCode).toBe(201);
    const [pack, drive] = first.json() as Todo[];
    expect([pack?.title, drive?.title]).toEqual(["Pack", "Drive"]);
    expect([pack?.position, drive?.position]).toEqual([0, 1]);
    expect(pack).toMatchObject({ parentId: parent.id, projectId: project.id });
    const second = json<Todo[]>(
      await t.call("POST", `/api/v1/todos/${parent.id}/subtasks`, { titles: ["Unpack"] }),
    );
    expect(second[0]?.position).toBe(2);

    const subtaskEvents = await events(t, parent.id, "subtasks_changed");
    expect(subtaskEvents.map((e) => e.data)).toEqual([
      {
        added: [
          { id: pack?.id, title: "Pack" },
          { id: drive?.id, title: "Drive" },
        ],
        removed: [],
      },
      { added: [{ id: second[0]?.id, title: "Unpack" }], removed: [] },
    ]);
    expect((await events(t, pack?.id as number, "created"))[0]?.data).toMatchObject({
      to: { parentId: parent.id },
    });
    expect((await getTodo(t, parent.id)).lastActivityAt).toBe("2026-11-11T10:01:00.000Z");
    const children = json<{ items: Todo[] }>(
      await t.call("GET", `/api/v1/todos?sort=position&order=asc`),
    ).items.filter((x) => x.parentId === parent.id);
    expect(children.map((c) => c.title)).toEqual(["Pack", "Drive", "Unpack"]);
  });

  it("answers 404 for an unknown parent and 422 beyond five levels", async () => {
    const t = await makeApp();
    expect((await t.call("POST", "/api/v1/todos/999/subtasks", { titles: ["x"] })).statusCode).toBe(404);
    let id = (await t.create<Todo>("/api/v1/todos", { title: "Level 1" })).id;
    for (let level = 2; level <= 5; level += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each level needs the one before
      const res = await t.call("POST", `/api/v1/todos/${id}/subtasks`, { titles: [`Level ${level}`] });
      expect(res.statusCode).toBe(201);
      id = (res.json() as Todo[])[0]?.id as number;
    }
    const tooDeep = await t.call("POST", `/api/v1/todos/${id}/subtasks`, { titles: ["Level 6"] });
    expect(tooDeep.statusCode).toBe(422);
    expect(tooDeep.json().error.message).toMatch(/at most 5 levels/);
  });

  it("detaches children with events when the parent is deleted", async () => {
    const t = await makeApp();
    const parent = await t.create<Todo>("/api/v1/todos", { title: "Parent" });
    const [a, b] = json<Todo[]>(
      await t.call("POST", `/api/v1/todos/${parent.id}/subtasks`, { titles: ["A", "B"] }),
    );
    const [grand] = json<Todo[]>(
      await t.call("POST", `/api/v1/todos/${a?.id}/subtasks`, { titles: ["Grand"] }),
    );
    t.advance(1000);
    expect((await t.call("DELETE", `/api/v1/todos/${parent.id}`)).statusCode).toBe(204);
    expect((await getTodo(t, a?.id as number)).parentId).toBeNull();
    expect((await getTodo(t, b?.id as number)).parentId).toBeNull();
    expect((await getTodo(t, grand?.id as number)).parentId).toBe(a?.id);
    const [moved] = await events(t, a?.id as number, "parent_changed");
    // The deleted parent shows with title null.
    expect(moved?.data).toEqual({ from: { id: parent.id, title: null }, to: null });

    // Deleting a child records it on its parent.
    expect((await t.call("DELETE", `/api/v1/todos/${grand?.id}`)).statusCode).toBe(204);
    const [removed] = (await events(t, a?.id as number, "subtasks_changed")).slice(-1);
    expect(removed?.data).toEqual({ added: [], removed: [{ id: grand?.id, title: null }] });
  });
});

async function three(t: TestApp) {
  const a = await t.create<Todo>("/api/v1/todos", { title: "A" });
  const b = await t.create<Todo>("/api/v1/todos", { title: "B" });
  const c = await t.create<Todo>("/api/v1/todos", { title: "C" });
  return { a, b, c };
}

describe("links", () => {
  it("adds links idempotently and records mirrored events on both todos", async () => {
    const t = await makeApp();
    const { a, b, c } = await three(t);
    const res = await t.call("POST", `/api/v1/todos/${a.id}/links`, {
      links: [
        { kind: "blocks", todoId: b.id },
        { kind: "relates", todoId: c.id },
        { kind: "blocked_by", todoId: c.id },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(a.id);
    const rows = t.deps.db.$client
      .prepare("SELECT from_id, to_id, kind, created_by FROM todo_links ORDER BY id")
      .all();
    expect(rows).toEqual([
      { from_id: a.id, to_id: b.id, kind: "blocks", created_by: "you" },
      { from_id: a.id, to_id: c.id, kind: "relates", created_by: "you" },
      { from_id: c.id, to_id: a.id, kind: "blocks", created_by: "you" },
    ]);
    expect((await events(t, a.id, "links_changed")).map((e) => e.data)).toEqual([
      { kind: "blocks", added: [{ id: b.id, title: "B" }], removed: [] },
      { kind: "relates", added: [{ id: c.id, title: "C" }], removed: [] },
      { kind: "blocked_by", added: [{ id: c.id, title: "C" }], removed: [] },
    ]);
    expect((await events(t, b.id, "links_changed")).map((e) => e.data)).toEqual([
      { kind: "blocked_by", added: [{ id: a.id, title: "A" }], removed: [] },
    ]);
    expect((await events(t, c.id, "links_changed")).map((e) => e.data)).toEqual([
      { kind: "relates", added: [{ id: a.id, title: "A" }], removed: [] },
      { kind: "blocks", added: [{ id: a.id, title: "A" }], removed: [] },
    ]);

    // Again, and "relates" from the other side: nothing new.
    await t.call("POST", `/api/v1/todos/${a.id}/links`, { links: [{ kind: "blocks", todoId: b.id }] });
    await t.call("POST", `/api/v1/todos/${c.id}/links`, { links: [{ kind: "relates", todoId: a.id }] });
    expect(t.deps.db.$client.prepare("SELECT count(*) AS n FROM todo_links").get()).toEqual({ n: 3 });
    expect(await events(t, b.id, "links_changed")).toHaveLength(1);
  });

  it("refuses self links, unknown todos and blocks loops", async () => {
    const t = await makeApp();
    const { a, b, c } = await three(t);
    const self = await t.call("POST", `/api/v1/todos/${a.id}/links`, {
      links: [{ kind: "relates", todoId: a.id }],
    });
    expect(self.statusCode).toBe(422);
    const unknown = await t.call("POST", `/api/v1/todos/${a.id}/links`, {
      links: [
        { kind: "relates", todoId: 98 },
        { kind: "blocks", todoId: 99 },
      ],
    });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().error.details).toEqual({ unknownTodoIds: [98, 99] });
    expect(
      (await t.call("POST", "/api/v1/todos/999/links", { links: [{ kind: "relates", todoId: a.id }] }))
        .statusCode,
    ).toBe(404);

    await t.call("POST", `/api/v1/todos/${a.id}/links`, { links: [{ kind: "blocks", todoId: b.id }] });
    await t.call("POST", `/api/v1/todos/${b.id}/links`, { links: [{ kind: "blocks", todoId: c.id }] });
    const loop = await t.call("POST", `/api/v1/todos/${c.id}/links`, {
      links: [{ kind: "blocks", todoId: a.id }],
    });
    expect(loop.statusCode).toBe(422);
    expect(loop.json().error.message).toBe(
      `That would make a loop: #${c.id} blocks #${a.id} blocks #${b.id} blocks #${c.id}.`,
    );
    // A loop inside one request is refused too, and nothing of that request is kept.
    const d = await t.create<Todo>("/api/v1/todos", { title: "D" });
    const inRequest = await t.call("POST", `/api/v1/todos/${d.id}/links`, {
      links: [
        { kind: "blocks", todoId: a.id },
        { kind: "blocked_by", todoId: c.id },
        { kind: "blocked_by", todoId: a.id },
      ],
    });
    expect(inRequest.statusCode).toBe(422);
    expect(t.deps.db.$client.prepare("SELECT count(*) AS n FROM todo_links").get()).toEqual({ n: 2 });
    // "relates" never makes a loop.
    expect(
      (await t.call("POST", `/api/v1/todos/${c.id}/links`, { links: [{ kind: "relates", todoId: a.id }] }))
        .statusCode,
    ).toBe(200);
  });

  it("deletes a link by kind from either side, with events, and cascades on todo delete", async () => {
    const t = await makeApp();
    const { a, b, c } = await three(t);
    await t.call("POST", `/api/v1/todos/${a.id}/links`, {
      links: [
        { kind: "blocks", todoId: b.id },
        { kind: "relates", todoId: c.id },
      ],
    });
    expect((await t.call("DELETE", `/api/v1/todos/${a.id}/links/${b.id}?kind=relates`)).statusCode).toBe(404);
    expect((await t.call("DELETE", `/api/v1/todos/${a.id}/links/${b.id}?kind=blocked_by`)).statusCode).toBe(
      404,
    );
    expect((await t.call("DELETE", `/api/v1/todos/${b.id}/links/${a.id}?kind=blocked_by`)).statusCode).toBe(
      204,
    );
    expect((await events(t, a.id, "links_changed")).at(-1)?.data).toEqual({
      kind: "blocks",
      added: [],
      removed: [{ id: b.id, title: "B" }],
    });
    expect((await events(t, b.id, "links_changed")).at(-1)?.data).toEqual({
      kind: "blocked_by",
      added: [],
      removed: [{ id: a.id, title: "A" }],
    });
    expect((await t.call("DELETE", `/api/v1/todos/${a.id}/links/${b.id}?kind=nope`)).statusCode).toBe(422);
    await t.call("DELETE", `/api/v1/todos/${c.id}`);
    expect(t.deps.db.$client.prepare("SELECT count(*) AS n FROM todo_links").get()).toEqual({ n: 0 });
  });
});

describe("checklist toggle", () => {
  const description = "Steps:\n\n- [ ] Order cables\n- [x] Label ports\n\n```\n- [ ] not this\n```\n";

  it("checks one item byte-exactly, records checklist_changed and bumps activity", async () => {
    const t = await makeApp();
    const todo = await t.create<Todo>("/api/v1/todos", { title: "Rack", descriptionMd: description });
    t.advance(60_000);
    const res = await t.call("POST", `/api/v1/todos/${todo.id}/checklist`, {
      index: 0,
      checked: true,
      text: "Order cables",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().descriptionMd).toBe(description.replace("- [ ] Order", "- [x] Order"));
    expect(res.json().lastActivityAt).toBe("2026-11-11T10:01:00.000Z");
    expect((await events(t, todo.id)).map((e) => e.kind)).toEqual(["created", "checklist_changed"]);
    expect((await events(t, todo.id, "checklist_changed"))[0]?.data).toEqual({
      text: "Order cables",
      checked: true,
    });
    // Same state again: no new event.
    await t.call("POST", `/api/v1/todos/${todo.id}/checklist`, { index: 1, checked: true });
    expect(await events(t, todo.id, "checklist_changed")).toHaveLength(1);
    // The search index follows the description.
    const search = json<{ counts: { todo: number } }>(await t.call("GET", "/api/v1/search?q=cables"));
    expect(search.counts.todo).toBe(1);
  });

  it("answers 409 with the current items when the index or text is stale", async () => {
    const t = await makeApp();
    const todo = await t.create<Todo>("/api/v1/todos", { title: "Rack", descriptionMd: description });
    const stale = await t.call("POST", `/api/v1/todos/${todo.id}/checklist`, {
      index: 1,
      checked: false,
      text: "Order cables",
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({
      message: "The checklist changed. Reload and try again.",
      details: {
        items: [
          { index: 0, text: "Order cables", checked: false, line: 2 },
          { index: 1, text: "Label ports", checked: true, line: 3 },
        ],
      },
    });
    expect(
      (await t.call("POST", `/api/v1/todos/${todo.id}/checklist`, { index: 2, checked: true })).statusCode,
    ).toBe(409);
    expect((await getTodo(t, todo.id)).descriptionMd).toBe(description);
    expect(
      (await t.call("POST", "/api/v1/todos/999/checklist", { index: 0, checked: true })).statusCode,
    ).toBe(404);
  });

  it("lets a read token look but not toggle", async () => {
    const t = await makeApp();
    const todo = await t.create<Todo>("/api/v1/todos", { title: "Rack", descriptionMd: description });
    const read = t.token("reader", "read");
    expect(
      (await t.withToken(read, "POST", `/api/v1/todos/${todo.id}/checklist`, { index: 0, checked: true }))
        .statusCode,
    ).toBe(403);
    const write = t.token("mcp", "write");
    const res = await t.withToken(write, "POST", `/api/v1/todos/${todo.id}/checklist`, {
      index: 0,
      checked: true,
    });
    expect(res.statusCode).toBe(200);
    expect((await events(t, todo.id, "checklist_changed"))[0]?.actor).toBe("mcp");
  });
});
