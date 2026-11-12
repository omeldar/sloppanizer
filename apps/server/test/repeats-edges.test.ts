import type { Todo, TodoPage } from "@organizer/shared";
import { describe, expect, it } from "vitest";
import { json, makeApp, type TestApp } from "./helpers.ts";

const patch = (t: TestApp, id: number, body: unknown) => t.call("PATCH", `/api/v1/todos/${id}`, body);
const open = async (t: TestApp) =>
  json<TodoPage>(await t.call("GET", "/api/v1/todos?status=all&limit=500")).items.filter(
    (x) => x.status === "open",
  );

/** Marks a repeating todo done and returns the next occurrence. */
async function doneAndNext(t: TestApp, id: number): Promise<Todo> {
  const done = json<Todo>(await patch(t, id, { status: "done" }));
  expect(done.nextOccurrence, "a next occurrence").not.toBeNull();
  return json<Todo>(await t.call("GET", `/api/v1/todos/${done.nextOccurrence?.id}`));
}

describe("repeats at month ends", () => {
  it("falls back to the last day in short months and returns to day 31 afterwards", async () => {
    const t = await makeApp({ now: "2026-01-31T09:00:00.000Z" });
    const todo = await t.create<Todo>("/api/v1/todos", {
      title: "Invoices",
      dueOn: "2026-01-31",
      plannedOn: "2026-01-29",
      recurrence: { every: "month" },
    });
    const feb = await doneAndNext(t, todo.id);
    expect(feb).toMatchObject({ dueOn: "2026-02-28", plannedOn: "2026-02-26" });
    const mar = await doneAndNext(t, feb.id);
    // Day 31 is the rule, not "28 plus a month".
    expect(mar.dueOn).toBe("2026-03-31");
  });

  it("uses 29 February in a leap year", async () => {
    const t = await makeApp({ now: "2028-01-31T09:00:00.000Z" });
    const todo = await t.create<Todo>("/api/v1/todos", {
      title: "Leap",
      dueOn: "2028-01-31",
      recurrence: { every: "month" },
    });
    expect((await doneAndNext(t, todo.id)).dueOn).toBe("2028-02-29");
  });
});

describe("repeats and the time zone", () => {
  it("counts from the local day when the todo is done just after local midnight (CET to CEST, spring)", async () => {
    // 2026-03-28 23:30 UTC is 00:30 on 29 March in Zurich, the day the clocks go forward.
    const t = await makeApp({ now: "2026-03-28T23:30:00.000Z", timeZone: "Europe/Zurich" });
    const todo = await t.create<Todo>("/api/v1/todos", {
      title: "Local day",
      dueOn: "2026-03-20",
      recurrence: { every: "day", interval: 2, basis: "done" },
    });
    // Local date 2026-03-29 plus two days; a UTC date (03-28) would give 03-30.
    expect((await doneAndNext(t, todo.id)).dueOn).toBe("2026-03-31");
  });

  it("counts from the local day around the autumn change (CEST to CET)", async () => {
    // 2026-10-24 22:30 UTC is 00:30 on 25 October in Zurich.
    const t = await makeApp({ now: "2026-10-24T22:30:00.000Z", timeZone: "Europe/Zurich" });
    const todo = await t.create<Todo>("/api/v1/todos", {
      title: "Local day",
      dueOn: "2026-10-20",
      recurrence: { every: "day", basis: "done" },
    });
    expect((await doneAndNext(t, todo.id)).dueOn).toBe("2026-10-26");
  });

  it("keeps weekly dates on the same weekday across a DST week", async () => {
    const t = await makeApp({ now: "2026-03-26T10:00:00.000Z", timeZone: "Europe/Zurich" });
    const todo = await t.create<Todo>("/api/v1/todos", {
      title: "Thursday report",
      dueOn: "2026-03-26",
      recurrence: { every: "week" },
    });
    const next = await doneAndNext(t, todo.id);
    expect(next.dueOn).toBe("2026-04-02");
    expect((await doneAndNext(t, next.id)).dueOn).toBe("2026-04-09");
  });

  it("uses the configured zone, not the machine zone, for the done day in a far zone", async () => {
    // 2026-11-12 20:00 UTC is already 13 November in Auckland.
    const t = await makeApp({ now: "2026-11-12T20:00:00.000Z", timeZone: "Pacific/Auckland" });
    const todo = await t.create<Todo>("/api/v1/todos", {
      title: "Far away",
      dueOn: "2026-11-01",
      recurrence: { every: "day", interval: 1, basis: "done" },
    });
    expect((await doneAndNext(t, todo.id)).dueOn).toBe("2026-11-14");
  });
});

describe("repeat chains", () => {
  it("keeps the next occurrence when its predecessor is deleted", async () => {
    const t = await makeApp({ now: "2026-11-12T08:00:00.000Z" });
    const todo = await t.create<Todo>("/api/v1/todos", {
      title: "Chain",
      dueOn: "2026-11-12",
      recurrence: { every: "week" },
    });
    const next = await doneAndNext(t, todo.id);
    expect((await t.call("DELETE", `/api/v1/todos/${todo.id}`)).statusCode).toBe(204);
    const kept = json<Todo>(await t.call("GET", `/api/v1/todos/${next.id}`));
    expect(kept.previousOccurrenceId).toBeNull();
    // It still repeats.
    expect((await doneAndNext(t, kept.id)).dueOn).toBe("2026-11-26");
  });

  it("creates exactly one next occurrence when done, reopened and done again quickly", async () => {
    const t = await makeApp({ now: "2026-11-12T08:00:00.000Z" });
    const todo = await t.create<Todo>("/api/v1/todos", {
      title: "Flip",
      dueOn: "2026-11-12",
      recurrence: { every: "week" },
    });
    for (let i = 0; i < 3; i++) {
      // oxlint-disable-next-line no-await-in-loop -- the calls must happen in order
      await patch(t, todo.id, { status: "done" });
      // oxlint-disable-next-line no-await-in-loop -- the calls must happen in order
      await patch(t, todo.id, { status: "open" });
    }
    await patch(t, todo.id, { status: "done" });
    expect((await open(t)).map((x) => x.title)).toEqual(["Flip"]);
  });

  it("repeats nothing when a repeating todo only changes to another active status or is deleted", async () => {
    const t = await makeApp({ now: "2026-11-12T08:00:00.000Z" });
    const todo = await t.create<Todo>("/api/v1/todos", {
      title: "Skip",
      dueOn: "2026-11-12",
      recurrence: { every: "week" },
    });
    for (const status of ["in_progress", "blocked", "open"]) {
      // oxlint-disable-next-line no-await-in-loop -- the calls must happen in order
      expect(json<Todo>(await patch(t, todo.id, { status })).nextOccurrence).toBeNull();
    }
    expect((await t.call("DELETE", `/api/v1/todos/${todo.id}`)).statusCode).toBe(204);
    expect((await open(t)).length).toBe(0);
  });
});
