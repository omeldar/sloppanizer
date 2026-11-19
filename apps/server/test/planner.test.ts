import type { TimeBlock, Todo } from "@organizer/shared";
import { describe, expect, it } from "vitest";
import { json, makeApp } from "./helpers.ts";

describe("web links of todos", () => {
  it("takes links when the todo is created and keeps their order", async () => {
    const t = await makeApp();
    const todo = await t.create<Todo>("/api/v1/todos", {
      title: "Ship it",
      urls: [
        { url: "https://github.com/omeldar/sloppanizer/pull/9", label: "PR" },
        { url: "example.com/spec" },
      ],
    });
    expect(todo.urls.map((u) => [u.url, u.label])).toEqual([
      ["https://github.com/omeldar/sloppanizer/pull/9", "PR"],
      ["https://example.com/spec", ""],
    ]);
  });

  it("adds, relabels and removes links, and skips a URL the todo has", async () => {
    const t = await makeApp();
    const todo = await t.create<Todo>("/api/v1/todos", { title: "Read" });
    const added = json<Todo>(
      await t.call("POST", `/api/v1/todos/${todo.id}/urls`, {
        urls: [
          { url: "https://a.example/x" },
          { url: "https://a.example/x" },
          { url: "mailto:bo@example.com" },
        ],
      }),
    );
    expect(added.urls).toHaveLength(2);
    const first = added.urls[0]?.id;
    const relabeled = json<Todo>(
      await t.call("PATCH", `/api/v1/todos/${todo.id}/urls/${first}`, { label: "Docs" }),
    );
    expect(relabeled.urls[0]?.label).toBe("Docs");
    const removed = json<Todo>(await t.call("DELETE", `/api/v1/todos/${todo.id}/urls/${first}`));
    expect(removed.urls.map((u) => u.url)).toEqual(["mailto:bo@example.com"]);
  });

  it("refuses scripts and other schemes", async () => {
    const t = await makeApp();
    const todo = await t.create<Todo>("/api/v1/todos", { title: "Safe" });
    for (const url of ["javascript:alert(1)", "data:text/html,x", "ftp://x.example/a", "not a url"]) {
      // oxlint-disable-next-line no-await-in-loop -- one after the other keeps the failing URL readable
      const res = await t.call("POST", `/api/v1/todos/${todo.id}/urls`, { urls: [{ url }] });
      expect(`${url}: ${res.statusCode}`).toBe(`${url}: 422`);
    }
  });

  it("copies the links to the next occurrence of a repeating todo", async () => {
    const t = await makeApp();
    const todo = await t.create<Todo>("/api/v1/todos", {
      title: "Weekly report",
      dueOn: "2026-11-11",
      recurrence: { every: "week" },
      urls: [{ url: "https://reports.example/weekly", label: "Template" }],
    });
    const done = json<Todo>(await t.call("PATCH", `/api/v1/todos/${todo.id}`, { status: "done" }));
    const next = json<Todo>(await t.call("GET", `/api/v1/todos/${done.nextOccurrence?.id}`));
    expect(next.urls.map((u) => u.label)).toEqual(["Template"]);
  });
});

/** An instant on 2026-11-12 (UTC). */
const at = (time: string) => `2026-11-12T${time}:00.000Z`;

describe("planner time blocks", () => {
  it("reserves time for a todo and lists it on its local day", async () => {
    // anna is in Europe/Zurich (UTC+1 in November).
    const t = await makeApp();
    const todo = await t.create<Todo>("/api/v1/todos", { title: "Write the guide" });
    const block = await t.create<TimeBlock>("/api/v1/blocks", {
      todoId: todo.id,
      startAt: "2026-11-12T08:00:00+01:00",
      endAt: "2026-11-12T09:30:00+01:00",
    });
    expect(block.startAt).toBe("2026-11-12T07:00:00.000Z");
    expect(block.todo?.title).toBe("Write the guide");

    const day = json<TimeBlock[]>(await t.call("GET", "/api/v1/blocks?from=2026-11-12&to=2026-11-12"));
    expect(day.map((b) => b.id)).toEqual([block.id]);
    const before = json<TimeBlock[]>(await t.call("GET", "/api/v1/blocks?from=2026-11-11&to=2026-11-11"));
    expect(before).toEqual([]);
    const byTodo = json<TimeBlock[]>(
      await t.call("GET", `/api/v1/blocks?from=2026-11-01&to=2026-11-30&todoId=${todo.id}`),
    );
    expect(byTodo).toHaveLength(1);
  });

  it("counts a block that crosses midnight on both days (account time zone)", async () => {
    const t = await makeApp();
    const block = await t.create<TimeBlock>("/api/v1/blocks", {
      title: "Night deploy",
      startAt: "2026-11-12T22:30:00.000Z",
      endAt: "2026-11-13T00:30:00.000Z",
    });
    // 23:30 to 01:30 in Zurich: the 12th and the 13th... the 13th local starts at 23:00Z on the 12th.
    for (const day of ["2026-11-12", "2026-11-13"]) {
      // oxlint-disable-next-line no-await-in-loop -- two days, read one after the other
      const list = json<TimeBlock[]>(await t.call("GET", `/api/v1/blocks?from=${day}&to=${day}`));
      expect(list.map((b) => `${day}:${b.id}`)).toEqual([`${day}:${block.id}`]);
    }
  });

  it("moves, renames and deletes a block", async () => {
    const t = await makeApp();
    const block = await t.create<TimeBlock>("/api/v1/blocks", {
      title: "Focus",
      startAt: "2026-11-12T08:00:00.000Z",
      endAt: "2026-11-12T09:00:00.000Z",
    });
    const moved = json<TimeBlock>(
      await t.call("PATCH", `/api/v1/blocks/${block.id}`, {
        startAt: "2026-11-12T13:00:00.000Z",
        endAt: "2026-11-12T15:00:00.000Z",
        title: "Deep work",
      }),
    );
    expect([moved.startAt, moved.endAt, moved.title]).toEqual([
      "2026-11-12T13:00:00.000Z",
      "2026-11-12T15:00:00.000Z",
      "Deep work",
    ]);
    // Moving the start past the end is refused.
    const wrong = await t.call("PATCH", `/api/v1/blocks/${block.id}`, {
      startAt: "2026-11-12T16:00:00.000Z",
    });
    expect(wrong.statusCode).toBe(422);
    expect((await t.call("DELETE", `/api/v1/blocks/${block.id}`)).statusCode).toBe(204);
    expect((await t.call("DELETE", `/api/v1/blocks/${block.id}`)).statusCode).toBe(404);
  });

  it("checks what a block is for and how long it lasts", async () => {
    const t = await makeApp();
    const cases = [
      { startAt: at("08:00"), endAt: at("09:00") },
      { title: "x", startAt: at("09:00"), endAt: at("08:00") },
      { title: "x", startAt: at("08:00"), endAt: at("08:02") },
      { title: "x", startAt: "2026-11-12T08:00:00.000Z", endAt: "2026-11-13T09:00:00.000Z" },
      { todoId: 999, startAt: at("08:00"), endAt: at("09:00") },
    ];
    const statuses = await Promise.all(
      cases.map(async (body) => (await t.call("POST", "/api/v1/blocks", body)).statusCode),
    );
    expect(statuses).toEqual([422, 422, 422, 422, 404]);
  });

  it("deletes a todo's blocks with the todo and keeps accounts apart", async () => {
    const t = await makeApp();
    const todo = await t.create<Todo>("/api/v1/todos", { title: "Gone soon" });
    await t.create("/api/v1/blocks", {
      todoId: todo.id,
      startAt: "2026-11-12T08:00:00.000Z",
      endAt: "2026-11-12T09:00:00.000Z",
    });
    const bo = await t.asAccount({ username: "bob" });
    const theirs = json<TimeBlock[]>(await bo.call("GET", "/api/v1/blocks?from=2026-11-12&to=2026-11-12"));
    expect(theirs).toEqual([]);
    const foreign = await bo.call("POST", "/api/v1/blocks", {
      todoId: todo.id,
      startAt: "2026-11-12T08:00:00.000Z",
      endAt: "2026-11-12T09:00:00.000Z",
    });
    expect(foreign.statusCode).toBe(404);

    await t.call("DELETE", `/api/v1/todos/${todo.id}`);
    expect(json<TimeBlock[]>(await t.call("GET", "/api/v1/blocks?from=2026-11-12&to=2026-11-12"))).toEqual(
      [],
    );
  });

  it("refuses a range longer than 62 days", async () => {
    const t = await makeApp();
    expect((await t.call("GET", "/api/v1/blocks?from=2026-01-01&to=2026-06-01")).statusCode).toBe(422);
  });
});

const block = (todoId: number, startAt: string, endAt: string) => ({ todoId, startAt, endAt }) as const;

describe("planned time and the planned day", () => {
  // The test clock starts on Wednesday 11.11.2026 in Zurich.

  it("plans the todo for the block's day, so the Week view shows it, and follows a move to another day", async () => {
    const t = await makeApp();
    const todo = await t.create<Todo>("/api/v1/todos", { title: "Write report" });
    // 23:30 UTC on the 12th is already the 13th in Zurich.
    const created = await t.create<TimeBlock>(
      "/api/v1/blocks",
      block(todo.id, "2026-11-12T23:30:00.000Z", "2026-11-13T00:30:00.000Z"),
    );
    expect(json<Todo>(await t.call("GET", `/api/v1/todos/${todo.id}`)).plannedOn).toBe("2026-11-13");
    const week = json<{ items: Todo[] }>(
      await t.call("GET", "/api/v1/todos?plannedFrom=2026-11-09&plannedTo=2026-11-15"),
    );
    expect(week.items.map((x) => x.id)).toEqual([todo.id]);

    // Moving within the day leaves the planned day; moving to another day takes it along.
    await t.call("PATCH", `/api/v1/blocks/${created.id}`, {
      startAt: "2026-11-13T08:00:00.000Z",
      endAt: "2026-11-13T09:00:00.000Z",
    });
    await t.call("PATCH", `/api/v1/todos/${todo.id}`, { plannedOn: "2026-11-20" });
    await t.call("PATCH", `/api/v1/blocks/${created.id}`, {
      startAt: "2026-11-13T10:00:00.000Z",
      endAt: "2026-11-13T11:00:00.000Z",
    });
    expect(json<Todo>(await t.call("GET", `/api/v1/todos/${todo.id}`)).plannedOn).toBe("2026-11-20");
    await t.call("PATCH", `/api/v1/blocks/${created.id}`, {
      startAt: "2026-11-16T08:00:00.000Z",
      endAt: "2026-11-16T09:00:00.000Z",
    });
    const moved = json<Todo>(await t.call("GET", `/api/v1/todos/${todo.id}`));
    expect(moved.plannedOn).toBe("2026-11-16");
    // The history says who planned it, like any date change.
    const activity = json<{
      items: { type: string; event?: { kind: string; actor: string; data: { to?: unknown } } }[];
    }>(await t.call("GET", `/api/v1/todos/${todo.id}/activity`));
    expect(
      activity.items
        .flatMap((i) => (i.event?.kind === "dates_changed" ? [i.event] : []))
        .map((e) => `${e.actor} ${(e.data.to as { plannedOn: string }).plannedOn}`),
    ).toEqual(["you 2026-11-13", "you 2026-11-20", "you 2026-11-16"]);
  });

  it("leaves done todos and blocks with only a title alone", async () => {
    const t = await makeApp();
    const done = await t.create<Todo>("/api/v1/todos", { title: "Old", status: "done" });
    await t.create("/api/v1/blocks", block(done.id, "2026-11-12T08:00:00.000Z", "2026-11-12T09:00:00.000Z"));
    expect(json<Todo>(await t.call("GET", `/api/v1/todos/${done.id}`)).plannedOn).toBeNull();
    const gym = await t.create<TimeBlock>("/api/v1/blocks", {
      title: "Gym",
      startAt: "2026-11-12T17:00:00.000Z",
      endAt: "2026-11-12T18:00:00.000Z",
    });
    expect(gym.todoId).toBeNull();
  });
});
