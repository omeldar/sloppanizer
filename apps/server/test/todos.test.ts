import type { Todo } from "@organizer/shared";
import { asc } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { events } from "../src/db/schema.ts";
import { DAY, json, makeApp, type TestApp } from "./helpers.ts";

const createTodo = (t: TestApp, body: Record<string, unknown>) => t.create<Todo>("/api/v1/todos", body);
const patch = (t: TestApp, id: number, body: unknown) => t.call("PATCH", `/api/v1/todos/${id}`, body);
const labelNames = (todo: Todo) => todo.labels.map((l) => l.name);
const eventRows = (t: TestApp) => t.deps.db.select().from(events).orderBy(asc(events.id)).all();

describe("todos CRUD", () => {
  it("creates, reads, updates and deletes a todo", async () => {
    const t = await makeApp();
    const project = await t.create<{ id: number }>("/api/v1/projects", { name: "Home lab" });
    const todo = await createTodo(t, {
      title: "  Renew SSL certs ",
      descriptionMd: "Use **certbot**.",
      projectId: project.id,
      dueOn: "2026-11-20",
      labels: ["priority::high"],
      requestedBy: [{ firstName: "Anna", lastName: "Meier" }],
    });
    expect(todo).toMatchObject({
      title: "Renew SSL certs",
      status: "open",
      projectId: project.id,
      project: { id: project.id, slug: "home-lab", name: "Home lab" },
      dueOn: "2026-11-20",
      createdAt: "2026-11-11T10:00:00.000Z",
      lastActivityAt: "2026-11-11T10:00:00.000Z",
      doneAt: null,
      durationMs: null,
    });
    expect(labelNames(todo)).toEqual(["priority::high"]);
    expect(todo.requestedBy.map((p) => p.displayName)).toEqual(["Anna Meier"]);

    expect(json<Todo>(await t.call("GET", `/api/v1/todos/${todo.id}`))).toEqual(todo);
    const updated = await patch(t, todo.id, { title: "Renew all certs", projectId: null });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ title: "Renew all certs", projectId: null, project: null });

    expect((await t.call("DELETE", `/api/v1/todos/${todo.id}`)).statusCode).toBe(204);
    expect((await t.call("GET", `/api/v1/todos/${todo.id}`)).statusCode).toBe(404);
    expect(eventRows(t)).toHaveLength(0);
  });

  it("never reuses ids of deleted todos", async () => {
    const t = await makeApp();
    const a = await createTodo(t, { title: "A" });
    const b = await createTodo(t, { title: "B" });
    await t.call("DELETE", `/api/v1/todos/${b.id}`);
    const c = await createTodo(t, { title: "C" });
    expect([a.id, b.id, c.id]).toEqual([1, 2, 3]);
  });

  it("answers validation errors with 422 and a helpful message", async () => {
    const t = await makeApp();
    const empty = await t.call("POST", "/api/v1/todos", { title: "" });
    expect(empty.statusCode).toBe(422);
    expect(empty.json().error).toMatchObject({ code: "validation_failed" });
    expect(empty.json().error.message).toContain("title");
    expect((await t.call("POST", "/api/v1/todos", { title: "x", extra: 1 })).statusCode).toBe(422);
    expect((await t.call("POST", "/api/v1/todos", { title: "x", dueOn: "2026-02-30" })).statusCode).toBe(422);
    expect((await t.call("POST", "/api/v1/todos", { title: "x", projectId: 99 })).statusCode).toBe(422);
    const notJson = await t.app.inject({
      method: "POST",
      url: "/api/v1/todos",
      headers: { cookie: t.cookie, "content-type": "application/json" },
      payload: "{bad",
    });
    expect(notJson.statusCode).toBe(422);
    expect((await t.call("GET", "/api/v1/todos/abc")).statusCode).toBe(422);
    const todo = await createTodo(t, { title: "x" });
    expect((await patch(t, todo.id, {})).statusCode).toBe(422);
    expect((await t.call("PATCH", "/api/v1/todos/999", { title: "y" })).statusCode).toBe(404);
  });

  it("does not let the API change createdAt", async () => {
    const t = await makeApp();
    const todo = await createTodo(t, { title: "Old" });
    const res = await patch(t, todo.id, { createdAt: "2020-01-01T00:00:00.000Z" });
    expect(res.statusCode).toBe(422);
    const mixed = await patch(t, todo.id, { title: "New", createdAt: "2020-01-01T00:00:00.000Z" });
    expect(mixed.statusCode).toBe(422);
    expect(
      (await t.call("POST", "/api/v1/todos", { title: "x", createdAt: "2020-01-01T00:00:00.000Z" }))
        .statusCode,
    ).toBe(422);
    t.advance(DAY);
    await patch(t, todo.id, { title: "Renamed" });
    expect(json<Todo>(await t.call("GET", `/api/v1/todos/${todo.id}`)).createdAt).toBe(
      "2026-11-11T10:00:00.000Z",
    );
  });
});

describe("status, done_at and durations", () => {
  it("sets done_at when done, clears it on reopen and sets it again", async () => {
    const t = await makeApp();
    const todo = await createTodo(t, { title: "Ship it" });
    t.advance(3 * DAY + 4 * 3_600_000);
    const done = json<Todo>(await patch(t, todo.id, { status: "done" }));
    expect(done.doneAt).toBe("2026-11-14T14:00:00.000Z");
    expect(done.durationMs).toBe(3 * DAY + 4 * 3_600_000);

    t.advance(DAY);
    const reopened = json<Todo>(await patch(t, todo.id, { status: "open" }));
    expect(reopened.doneAt).toBeNull();
    expect(reopened.durationMs).toBeNull();

    t.advance(DAY);
    const blocked = json<Todo>(await patch(t, todo.id, { status: "blocked" }));
    expect(blocked.doneAt).toBeNull();
    const doneAgain = json<Todo>(await patch(t, todo.id, { status: "done" }));
    expect(doneAgain.doneAt).toBe("2026-11-16T14:00:00.000Z");
    expect(doneAgain.durationMs).toBe(5 * DAY + 4 * 3_600_000);

    const statusEvents = eventRows(t).filter((e) => e.kind === "status_changed");
    expect(statusEvents.map((e) => JSON.parse(e.data))).toEqual([
      { from: "open", to: "done" },
      { from: "done", to: "open" },
      { from: "open", to: "blocked" },
      { from: "blocked", to: "done" },
    ]);
  });

  it("keeps done_at when a done todo is edited, and sets it for a todo created as done", async () => {
    const t = await makeApp();
    const todo = await createTodo(t, { title: "Already done", status: "done" });
    expect(todo.doneAt).toBe("2026-11-11T10:00:00.000Z");
    expect(todo.durationMs).toBe(0);
    t.advance(DAY);
    const edited = json<Todo>(await patch(t, todo.id, { title: "Already done, renamed", status: "done" }));
    expect(edited.doneAt).toBe("2026-11-11T10:00:00.000Z");
  });
});

describe("last_activity_at and events", () => {
  it("moves last_activity_at on every real change, not on no-ops or reordering", async () => {
    const t = await makeApp();
    const todo = await createTodo(t, { title: "Idle" });
    t.advance(DAY);
    const same = json<Todo>(await patch(t, todo.id, { title: "Idle" }));
    expect(same.lastActivityAt).toBe(todo.lastActivityAt);
    expect(same.updatedAt).toBe(todo.updatedAt);

    const moved = json<Todo>(await patch(t, todo.id, { position: 5 }));
    expect(moved.position).toBe(5);
    expect(moved.updatedAt).toBe("2026-11-12T10:00:00.000Z");
    expect(moved.lastActivityAt).toBe(todo.lastActivityAt);

    const changes = [
      { descriptionMd: "notes" },
      { dueOn: "2026-12-01" },
      { addLabels: ["priority::low"] },
      { addRequestedBy: [{ firstName: "Bo", lastName: "Li" }] },
      { status: "in_progress" },
    ];
    const seen: string[] = [];
    const expected: string[] = [];
    for (const change of changes) {
      t.advance(DAY);
      expected.push(t.deps.clock().toISOString());
      // Sequential on purpose: each change happens one day after the previous one.
      // oxlint-disable-next-line no-await-in-loop
      seen.push(json<Todo>(await patch(t, todo.id, change)).lastActivityAt);
    }
    expect(seen).toEqual(expected);
  });

  it("records one event per kind of change with from/to and the actor", async () => {
    const t = await makeApp();
    const project = await t.create<{ id: number }>("/api/v1/projects", { name: "P" });
    const todo = await createTodo(t, { title: "A", labels: ["priority::low"] });
    await patch(t, todo.id, {
      title: "B",
      descriptionMd: "d",
      projectId: project.id,
      dueOn: "2026-12-01",
      plannedOn: "2026-11-12",
      labels: ["priority::high"],
      requestedBy: [{ firstName: "Anna", lastName: "Meier" }],
    });
    const rows = eventRows(t);
    expect(rows.every((e) => e.actor === "you" && e.todoId === todo.id)).toBe(true);
    const byKind = Object.fromEntries(rows.map((e) => [e.kind, JSON.parse(e.data)]));
    expect(Object.keys(byKind).toSorted()).toEqual(
      [
        "created",
        "description_changed",
        "dates_changed",
        "labels_changed",
        "people_changed",
        "project_changed",
        "title_changed",
      ].toSorted(),
    );
    expect(byKind.title_changed).toEqual({ from: "A", to: "B" });
    expect(byKind.project_changed).toEqual({ from: null, to: project.id });
    expect(byKind.dates_changed).toEqual({
      from: { dueOn: null, plannedOn: null },
      to: { dueOn: "2026-12-01", plannedOn: "2026-11-12" },
    });
    expect(byKind.labels_changed).toEqual({ from: ["priority::low"], to: ["priority::high"] });
    expect(byKind.people_changed.from).toEqual([]);
    expect(byKind.people_changed.to).toEqual([{ id: 1, name: "Anna Meier" }]);
    expect(byKind.created.to).toMatchObject({ title: "A", labels: ["priority::low"] });
  });
});

describe("scoped label exclusivity", () => {
  it("replaces the sibling of a scope when a scoped label is added", async () => {
    const t = await makeApp();
    await t.create("/api/v1/labels", { name: "homelab" });
    const todo = await createTodo(t, { title: "x", labels: ["priority::high", "homelab"] });
    const res = json<Todo>(await patch(t, todo.id, { addLabels: ["priority::low"] }));
    expect(labelNames(res)).toEqual(["priority::low", "homelab"]);
    const removed = json<Todo>(await patch(t, todo.id, { removeLabels: ["homelab"] }));
    expect(labelNames(removed)).toEqual(["priority::low"]);
  });

  it("uses the stored spelling and accepts names in any case", async () => {
    const t = await makeApp();
    const todo = await createTodo(t, { title: "x", labels: ["Priority::HIGH"] });
    expect(labelNames(todo)).toEqual(["priority::high"]);
  });

  it("sets the full set and keeps scoped labels before plain ones", async () => {
    const t = await makeApp();
    await t.create("/api/v1/labels", { name: "alpha" });
    await t.create("/api/v1/labels", { name: "env::prod" });
    const todo = await createTodo(t, { title: "x", labels: ["alpha"] });
    const res = json<Todo>(await patch(t, todo.id, { labels: ["alpha", "priority::critical", "env::prod"] }));
    expect(labelNames(res)).toEqual(["env::prod", "priority::critical", "alpha"]);
    const cleared = json<Todo>(await patch(t, todo.id, { labels: [] }));
    expect(cleared.labels).toEqual([]);
  });

  it("rejects two labels of one scope in one request (422)", async () => {
    const t = await makeApp();
    const create = await t.call("POST", "/api/v1/todos", {
      title: "x",
      labels: ["priority::high", "priority::low"],
    });
    expect(create.statusCode).toBe(422);
    const todo = await createTodo(t, { title: "x" });
    expect((await patch(t, todo.id, { labels: ["priority::high", "priority::low"] })).statusCode).toBe(422);
    expect((await patch(t, todo.id, { addLabels: ["priority::high", "priority::low"] })).statusCode).toBe(
      422,
    );
    const bulk = await t.call("POST", "/api/v1/todos/bulk", {
      ids: [todo.id],
      patch: { addLabels: ["priority::critical", "priority::low"] },
    });
    expect(bulk.statusCode).toBe(422);
    expect(json<Todo>(await t.call("GET", `/api/v1/todos/${todo.id}`)).labels).toEqual([]);
  });

  it("rejects unknown labels with 422 listing every unknown name", async () => {
    const t = await makeApp();
    const res = await t.call("POST", "/api/v1/todos", {
      title: "x",
      labels: ["nope", "priority::high", "also-nope"],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details).toEqual({ unknownLabels: ["nope", "also-nope"] });
    expect(res.json().error.message).toContain("nope, also-nope");
  });

  it("applies exclusivity per todo in a bulk update", async () => {
    const t = await makeApp();
    await t.create("/api/v1/labels", { name: "homelab" });
    const a = await createTodo(t, { title: "a", labels: ["priority::high", "homelab"] });
    const b = await createTodo(t, { title: "b", labels: ["priority::low"] });
    const c = await createTodo(t, { title: "c" });
    const res = await t.call("POST", "/api/v1/todos/bulk", {
      ids: [c.id, a.id, b.id],
      patch: { addLabels: ["priority::critical"], status: "in_progress" },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json().updated as Todo[];
    expect(updated.map((u) => u.id)).toEqual([c.id, a.id, b.id]);
    expect(updated.map(labelNames)).toEqual([
      ["priority::critical"],
      ["priority::critical", "homelab"],
      ["priority::critical"],
    ]);
    expect(updated.every((u) => u.status === "in_progress")).toBe(true);
  });
});

describe("bulk update", () => {
  it("changes nothing when an id does not exist (404)", async () => {
    const t = await makeApp();
    const a = await createTodo(t, { title: "a" });
    const res = await t.call("POST", "/api/v1/todos/bulk", { ids: [a.id, 77], patch: { status: "done" } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.details).toEqual({ missingIds: [77] });
    expect(json<Todo>(await t.call("GET", `/api/v1/todos/${a.id}`)).status).toBe("open");
  });

  it("validates ids and patch", async () => {
    const t = await makeApp();
    expect(
      (await t.call("POST", "/api/v1/todos/bulk", { ids: [], patch: { status: "done" } })).statusCode,
    ).toBe(422);
    expect(
      (await t.call("POST", "/api/v1/todos/bulk", { ids: [1, 1], patch: { status: "done" } })).statusCode,
    ).toBe(422);
    expect((await t.call("POST", "/api/v1/todos/bulk", { ids: [1], patch: { title: "x" } })).statusCode).toBe(
      422,
    );
  });
});

async function seedList(t: TestApp) {
  const p = await t.create<{ id: number }>("/api/v1/projects", { name: "P" });
  await t.create("/api/v1/labels", { name: "homelab" });
  const a = await createTodo(t, {
    title: "Alpha cert",
    labels: ["priority::low", "homelab"],
    dueOn: "2026-11-20",
  });
  t.advance(1000);
  const b = await createTodo(t, {
    title: "Beta",
    projectId: p.id,
    labels: ["priority::critical"],
    plannedOn: "2026-11-12",
  });
  t.advance(1000);
  const c = await createTodo(t, { title: "Gamma 100%", status: "done", dueOn: "2026-11-15" });
  t.advance(1000);
  const d = await createTodo(t, {
    title: "Delta",
    requestedBy: [{ firstName: "Anna", lastName: "Meier" }],
  });
  return { p, a, b, c, d };
}
const ids = (res: { json: () => { items: Todo[] } }) => res.json().items.map((x) => x.id);

describe("list", () => {
  it("filters by status, project, label, person, q, dueBefore and plannedOn", async () => {
    const t = await makeApp();
    const { p, a, b, c, d } = await seedList(t);
    expect(ids(await t.call("GET", "/api/v1/todos"))).toEqual([d.id, b.id, a.id]);
    expect(ids(await t.call("GET", "/api/v1/todos?status=all"))).toEqual([d.id, c.id, b.id, a.id]);
    expect(ids(await t.call("GET", "/api/v1/todos?status=done"))).toEqual([c.id]);
    expect(ids(await t.call("GET", `/api/v1/todos?projectId=${p.id}`))).toEqual([b.id]);
    expect(ids(await t.call("GET", "/api/v1/todos?projectId=inbox"))).toEqual([d.id, a.id]);
    expect(ids(await t.call("GET", "/api/v1/todos?label=homelab,priority::low"))).toEqual([a.id]);
    expect(ids(await t.call("GET", "/api/v1/todos?label=homelab,priority::critical"))).toEqual([]);
    expect((await t.call("GET", "/api/v1/todos?label=homelab")).json().total).toBe(1);
    expect((await t.call("GET", "/api/v1/todos?personId=1&status=all")).json().total).toBe(1);
    expect(ids(await t.call("GET", "/api/v1/todos?personId=1"))).toEqual([d.id]);
    expect(ids(await t.call("GET", "/api/v1/todos?q=CERT"))).toEqual([a.id]);
    expect(ids(await t.call("GET", "/api/v1/todos?q=100%25&status=all"))).toEqual([c.id]);
    expect(ids(await t.call("GET", "/api/v1/todos?q=_"))).toEqual([]);
    expect(ids(await t.call("GET", "/api/v1/todos?dueBefore=2026-11-21&status=all"))).toEqual([c.id, a.id]);
    expect(ids(await t.call("GET", "/api/v1/todos?plannedOn=2026-11-12"))).toEqual([b.id]);
    expect((await t.call("GET", "/api/v1/todos?status=nope")).statusCode).toBe(422);
  });

  it("sorts and pages", async () => {
    const t = await makeApp();
    const { a, b, d } = await seedList(t);
    expect(ids(await t.call("GET", "/api/v1/todos?sort=created&order=asc"))).toEqual([a.id, b.id, d.id]);
    expect(ids(await t.call("GET", "/api/v1/todos?sort=priority"))).toEqual([b.id, d.id, a.id]);
    expect(ids(await t.call("GET", "/api/v1/todos?sort=priority&order=asc"))).toEqual([a.id, d.id, b.id]);
    // Same due date (none): ties follow the order on the id.
    expect(ids(await t.call("GET", "/api/v1/todos?sort=due&order=asc"))).toEqual([a.id, b.id, d.id]);
    expect(ids(await t.call("GET", "/api/v1/todos?sort=due&order=desc"))).toEqual([a.id, d.id, b.id]);
    const page = (await t.call("GET", "/api/v1/todos?limit=2&offset=1&sort=created&order=asc")).json();
    expect(page).toMatchObject({ total: 3, limit: 2, offset: 1 });
    expect(page.items.map((x: Todo) => x.id)).toEqual([b.id, d.id]);
    expect((await t.call("GET", "/api/v1/todos?limit=501")).statusCode).toBe(422);
  });
});
