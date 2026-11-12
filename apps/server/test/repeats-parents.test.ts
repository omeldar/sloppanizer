import type { Activity, ActivityEvent, NextUp, Person, Project, Todo, TodoPage } from "@organizer/shared";
import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { parse } from "yaml";
import { json, makeApp, type TestApp } from "./helpers.ts";

const events = async (t: TestApp, id: number, kind: string): Promise<ActivityEvent[]> =>
  json<Activity>(await t.call("GET", `/api/v1/todos/${id}/activity`))
    .items.flatMap((item) => (item.type === "event" ? [item.event] : []))
    .filter((e) => e.kind === kind);

const getTodo = async (t: TestApp, id: number) => json<Todo>(await t.call("GET", `/api/v1/todos/${id}`));
const patch = (t: TestApp, id: number, body: unknown) => t.call("PATCH", `/api/v1/todos/${id}`, body);
const all = async (t: TestApp) =>
  json<TodoPage>(await t.call("GET", "/api/v1/todos?status=all&limit=500")).items;

const weekly = { every: "week" } as const;
const scoreOf = (n: NextUp, id: number) => n.items.find((i) => i.todo.id === id)?.score ?? 0;

describe("todo output for step 3", () => {
  it("carries parent, progress, links and repeat facts", async () => {
    const t = await makeApp();
    const parent = await t.create<Todo>("/api/v1/todos", {
      title: "Parent",
      descriptionMd: "- [x] a\n- [ ] b\n- [ ] c",
      dueOn: "2026-11-12",
      recurrence: weekly,
    });
    const [a, b] = json<Todo[]>(
      await t.call("POST", `/api/v1/todos/${parent.id}/subtasks`, { titles: ["A", "B"] }),
    );
    await patch(t, a?.id as number, { status: "done" });
    await t.call("POST", `/api/v1/todos/${parent.id}/links`, {
      links: [{ kind: "blocked_by", todoId: b?.id }],
    });
    const p = await getTodo(t, parent.id);
    expect(p).toMatchObject({
      parent: null,
      progress: { subtasks: { total: 2, done: 1 }, checklist: { total: 3, done: 1 } },
      links: { blocks: [], blockedBy: [{ id: b?.id, title: "B", status: "open" }], relatesTo: [] },
      recurrence: { every: "week", interval: 1, weekdays: ["thu"], basis: "schedule" },
      previousOccurrenceId: null,
      nextOccurrence: null,
    });
    expect((await getTodo(t, b?.id as number)).parent).toEqual({
      id: parent.id,
      title: "Parent",
      status: "open",
    });
    expect((await getTodo(t, b?.id as number)).links.blocks).toEqual([
      { id: parent.id, title: "Parent", status: "open" },
    ]);
  });
});

describe("parents through create and update", () => {
  it("creates a subtask in the parent's project unless told otherwise", async () => {
    const t = await makeApp();
    const project = await t.create<Project>("/api/v1/projects", { name: "Lab" });
    const parent = await t.create<Todo>("/api/v1/todos", { title: "Parent", projectId: project.id });
    const child = await t.create<Todo>("/api/v1/todos", { title: "Child", parentId: parent.id });
    expect(child).toMatchObject({ parentId: parent.id, projectId: project.id, position: 0 });
    const inbox = await t.create<Todo>("/api/v1/todos", {
      title: "Inbox child",
      parentId: parent.id,
      projectId: null,
    });
    expect(inbox).toMatchObject({ projectId: null, position: 1 });
    expect((await events(t, parent.id, "subtasks_changed")).map((e) => e.data)).toEqual([
      { added: [{ id: child.id, title: "Child" }], removed: [] },
      { added: [{ id: inbox.id, title: "Inbox child" }], removed: [] },
    ]);
    expect((await t.call("POST", "/api/v1/todos", { title: "x", parentId: 999 })).statusCode).toBe(422);
    const children = json<TodoPage>(
      await t.call("GET", `/api/v1/todos?parentId=${parent.id}&sort=position&order=asc`),
    );
    expect(children.items.map((c) => c.title)).toEqual(["Child", "Inbox child"]);
    const top = json<TodoPage>(await t.call("GET", "/api/v1/todos?parentId=none"));
    expect(top.items.map((c) => c.title)).toEqual(["Parent"]);
  });

  it("moves a todo between parents with events on all three, and refuses cycles and depth", async () => {
    const t = await makeApp();
    const first = await t.create<Todo>("/api/v1/todos", { title: "First" });
    const second = await t.create<Todo>("/api/v1/todos", { title: "Second" });
    const child = await t.create<Todo>("/api/v1/todos", { title: "Child", parentId: first.id });
    const grand = await t.create<Todo>("/api/v1/todos", { title: "Grand", parentId: child.id });
    t.advance(60_000);
    expect((await patch(t, child.id, { parentId: second.id })).statusCode).toBe(200);
    expect((await events(t, child.id, "parent_changed")).at(-1)?.data).toEqual({
      from: { id: first.id, title: "First" },
      to: { id: second.id, title: "Second" },
    });
    expect((await events(t, first.id, "subtasks_changed")).at(-1)?.data).toEqual({
      added: [],
      removed: [{ id: child.id, title: "Child" }],
    });
    expect((await events(t, second.id, "subtasks_changed")).at(-1)?.data).toEqual({
      added: [{ id: child.id, title: "Child" }],
      removed: [],
    });
    expect((await getTodo(t, first.id)).lastActivityAt).toBe("2026-11-11T10:01:00.000Z");
    const cycle = await patch(t, second.id, { parentId: grand.id });
    expect(cycle.statusCode).toBe(422);
    expect(cycle.json().error.message).toBe("A todo cannot be a subtask of its own subtask.");
    expect((await patch(t, child.id, { parentId: child.id })).statusCode).toBe(422);
    // Levels: second(1) > child(2) > grand(3); a 3-level chain under grand would reach 6.
    const deep = await t.create<Todo>("/api/v1/todos", { title: "Deep" });
    const deeper = await t.create<Todo>("/api/v1/todos", { title: "Deeper", parentId: deep.id });
    await t.create<Todo>("/api/v1/todos", { title: "Deepest", parentId: deeper.id });
    expect((await patch(t, deep.id, { parentId: grand.id })).statusCode).toBe(422);
    expect((await patch(t, deeper.id, { parentId: grand.id })).statusCode).toBe(200);
    // Back to the top level.
    expect((await patch(t, child.id, { parentId: null })).statusCode).toBe(200);
    expect((await events(t, child.id, "parent_changed")).at(-1)?.data).toEqual({
      from: { id: second.id, title: "Second" },
      to: null,
    });
  });
});

describe("repeating todos", () => {
  it("needs a date and stores the rule normalized, with events", async () => {
    const t = await makeApp();
    const none = await t.call("POST", "/api/v1/todos", { title: "x", recurrence: weekly });
    expect(none.statusCode).toBe(422);
    expect(none.json().error.message).toBe("A repeating todo needs a due date or a planned day.");
    const todo = await t.create<Todo>("/api/v1/todos", { title: "Report", plannedOn: "2026-01-31" });
    const set = json<Todo>(await patch(t, todo.id, { recurrence: { every: "month" } }));
    expect(set.recurrence).toEqual({ every: "month", interval: 1, monthDay: 31, basis: "schedule" });
    expect((await events(t, todo.id, "recurrence_changed")).at(-1)?.data).toMatchObject({ from: null });
    expect((await patch(t, todo.id, { plannedOn: null })).statusCode).toBe(422);
    expect((await patch(t, todo.id, { recurrence: { every: "day", until: "2025-12-31" } })).statusCode).toBe(
      422,
    );
    expect(
      (await patch(t, todo.id, { recurrence: { every: "week", basis: "done", weekdays: ["mon"] } }))
        .statusCode,
    ).toBe(422);
    const stopped = json<Todo>(await patch(t, todo.id, { recurrence: null }));
    expect(stopped.recurrence).toBeNull();
    expect((await events(t, todo.id, "recurrence_changed")).at(-1)?.data).toMatchObject({ to: null });
  });

  it("creates the next one on done with copied fields, reset checklist and moved dates", async () => {
    const t = await makeApp({ now: "2026-11-12T08:00:00.000Z" });
    const anna = await t.create<Person>("/api/v1/people", { firstName: "Anna", lastName: "Meier" });
    const project = await t.create<Project>("/api/v1/projects", { name: "Ops" });
    const todo = await t.create<Todo>("/api/v1/todos", {
      title: "Check backups",
      descriptionMd: "- [x] disk\n- [ ] tape",
      projectId: project.id,
      labels: ["priority::high"],
      requestedBy: [{ personId: anna.id }],
      contacts: [{ personId: anna.id }],
      dueOn: "2026-11-12",
      plannedOn: "2026-11-11",
      recurrence: weekly,
    });
    await t.call("POST", `/api/v1/todos/${todo.id}/subtasks`, { titles: ["Not copied"] });
    await t.call("POST", `/api/v1/todos/${todo.id}/comments`, { bodyMd: "Not copied either" });
    const done = json<Todo>(await patch(t, todo.id, { status: "done" }));
    expect(done.nextOccurrence).toMatchObject({ title: "Check backups", status: "open" });
    const next = await getTodo(t, done.nextOccurrence?.id as number);
    expect(next).toMatchObject({
      title: "Check backups",
      descriptionMd: "- [ ] disk\n- [ ] tape",
      projectId: project.id,
      dueOn: "2026-11-19",
      plannedOn: "2026-11-18",
      parentId: null,
      previousOccurrenceId: todo.id,
      commentCount: 0,
      recurrence: done.recurrence,
      progress: { subtasks: { total: 0, done: 0 }, checklist: { total: 2, done: 0 } },
    });
    expect(next.labels.map((l) => l.name)).toEqual(["priority::high"]);
    expect(next.requestedBy.map((p) => p.id)).toEqual([anna.id]);
    expect(next.contacts.map((p) => p.id)).toEqual([anna.id]);
    expect((await events(t, todo.id, "recurred"))[0]?.data).toEqual({
      next: { id: next.id, title: "Check backups", dueOn: "2026-11-19", plannedOn: "2026-11-18" },
    });
    expect((await events(t, next.id, "created"))[0]?.data).toMatchObject({
      to: { previousOccurrenceId: todo.id },
    });
    // A second "done" (already done) creates nothing more.
    await patch(t, todo.id, { status: "done" });
    expect((await all(t)).filter((x) => x.title === "Check backups")).toHaveLength(2);
  });

  it("undo removes an untouched next one and keeps a touched one", async () => {
    const t = await makeApp({ now: "2026-11-12T08:00:00.000Z" });
    const todo = await t.create<Todo>("/api/v1/todos", {
      title: "Water plants",
      dueOn: "2026-11-12",
      recurrence: weekly,
    });
    const nextId = json<Todo>(await patch(t, todo.id, { status: "done" })).nextOccurrence?.id as number;
    expect(json<Todo>(await patch(t, todo.id, { status: "open" })).nextOccurrence).toBeNull();
    expect((await t.call("GET", `/api/v1/todos/${nextId}`)).statusCode).toBe(404);

    const again = json<Todo>(await patch(t, todo.id, { status: "done" })).nextOccurrence?.id as number;
    t.advance(1000);
    await patch(t, again, { title: "Water plants (big ones)" });
    await patch(t, todo.id, { status: "in_progress" });
    expect((await getTodo(t, again)).title).toBe("Water plants (big ones)");
    // Done again: the touched next one still exists, so no third one.
    await patch(t, todo.id, { status: "done" });
    expect((await all(t)).length).toBe(2);
  });

  it("works through bulk, skips missed dates, stops after until and counts from done", async () => {
    const t = await makeApp({ now: "2026-11-16T08:00:00.000Z" });
    const late = await t.create<Todo>("/api/v1/todos", {
      title: "Late",
      dueOn: "2026-10-22",
      recurrence: weekly,
    });
    const ending = await t.create<Todo>("/api/v1/todos", {
      title: "Ending",
      dueOn: "2026-11-16",
      recurrence: { every: "week", until: "2026-11-20" },
    });
    const fromDone = await t.create<Todo>("/api/v1/todos", {
      title: "From done",
      dueOn: "2026-11-01",
      recurrence: { every: "day", interval: 3, basis: "done" },
    });
    const res = await t.call("POST", "/api/v1/todos/bulk", {
      ids: [late.id, ending.id, fromDone.id],
      patch: { status: "done" },
    });
    expect(res.statusCode).toBe(200);
    const byTitle = new Map((await all(t)).filter((x) => x.status === "open").map((x) => [x.title, x]));
    // Weekly on Thursday, done on Monday 2026-11-16: the next Thursday, not the missed ones.
    expect(byTitle.get("Late")?.dueOn).toBe("2026-11-19");
    expect(byTitle.has("Ending")).toBe(false);
    expect(byTitle.get("From done")?.dueOn).toBe("2026-11-19");
  });
});

describe("Next up with links", () => {
  it("puts a todo waiting on an active blocker in blocked and gives the blocker points", async () => {
    const t = await makeApp();
    const a = await t.create<Todo>("/api/v1/todos", { title: "A" });
    const b = await t.create<Todo>("/api/v1/todos", { title: "B" });
    const before = json<NextUp>(await t.call("GET", "/api/v1/next"));
    await t.call("POST", `/api/v1/todos/${b.id}/links`, { links: [{ kind: "blocks", todoId: a.id }] });
    const next = json<NextUp>(await t.call("GET", "/api/v1/next"));
    expect(next.items.map((i) => i.todo.id)).toEqual([b.id]);
    expect(next.blocked.map((x) => x.id)).toEqual([a.id]);
    expect(scoreOf(next, b.id)).toBe(scoreOf(before, b.id) + 5);
    expect(next.items[0]?.reasons).toContainEqual({ kind: "blocks", label: "blocks 1", points: 5 });
    await patch(t, b.id, { status: "done" });
    const after = json<NextUp>(await t.call("GET", "/api/v1/next"));
    expect(after.items.map((i) => i.todo.id)).toEqual([a.id]);
    expect(after.blocked).toEqual([]);
  });
});

describe("export front matter for step 3", () => {
  it("lists parent, subtasks, links, repeat and occurrences", async () => {
    const t = await makeApp({ now: "2026-11-12T08:00:00.000Z" });
    const parent = await t.create<Todo>("/api/v1/todos", {
      title: "Parent",
      dueOn: "2026-11-12",
      recurrence: weekly,
    });
    const child = await t.create<Todo>("/api/v1/todos", { title: "Child", parentId: parent.id });
    await t.call("POST", `/api/v1/todos/${parent.id}/links`, {
      links: [
        { kind: "blocked_by", todoId: child.id },
        { kind: "relates", todoId: child.id },
      ],
    });
    const nextId = json<Todo>(await patch(t, parent.id, { status: "done" })).nextOccurrence?.id;
    const files = unzipSync((await t.call("GET", "/api/v1/export.zip")).rawPayload);
    const meta = (name: string) => {
      const file = Object.keys(files).find((f) => f.startsWith(name)) as string;
      return parse(/^---\n([\s\S]*?)\n---/.exec(strFromU8(files[file] as Uint8Array))?.[1] ?? "");
    };
    expect(meta("todos/0001-")).toMatchObject({
      parent: null,
      subtasks: [child.id],
      blocks: [],
      blocked_by: [child.id],
      relates_to: [child.id],
      repeat: "every week on Thu",
      previous: null,
      next: nextId,
    });
    expect(meta("todos/0002-")).toMatchObject({ parent: parent.id, blocks: [parent.id], repeat: null });
    expect(meta(`todos/000${nextId}-`)).toMatchObject({ previous: parent.id, next: null });
  });
});
