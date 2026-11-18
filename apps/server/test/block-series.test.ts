import type { BlockOccurrence, BlockSeries, RecurringTodo, Todo } from "@organizer/shared";
import { describe, expect, it } from "vitest";
import { json, makeApp, type TestApp } from "./helpers.ts";

// The test clock starts on Wednesday 11.11.2026 at 11:00 in Zurich (10:00 UTC).

/** "Team report", due every Monday from 16.11.2026. */
const mondays = (t: TestApp, more: Record<string, unknown> = {}) =>
  t.create<Todo>("/api/v1/todos", {
    title: "Team report",
    dueOn: "2026-11-16",
    recurrence: { every: "week", weekdays: ["mon"] },
    ...more,
  });

/** Plans 09:00 to 10:00 Zurich time on a day for the todo's repeat. */
const plan = (t: TestApp, todoId: number, day: string, start = "08:00", end = "09:00") =>
  t.call("POST", `/api/v1/todos/${todoId}/plan`, {
    startAt: `${day}T${start}:00.000Z`,
    endAt: `${day}T${end}:00.000Z`,
  });

/** "date HH:MM(utc) status #todo" of every planned date of repeating todos in the range. */
const dates = async (t: TestApp, from = "2026-11-09", to = "2026-12-06", more = "") =>
  json<BlockOccurrence[]>(await t.call("GET", `/api/v1/blocks/series?from=${from}&to=${to}${more}`)).map(
    (o) =>
      `${o.occursOn} ${o.startAt.slice(11, 16)} ${o.status} #${o.todo.id}${o.todo.status === "done" ? " done" : ""}`,
  );

const change = (t: TestApp, todoId: number, on: string, body: unknown) =>
  t.call("PATCH", `/api/v1/todos/${todoId}/plan/${on}`, body);

const done = (t: TestApp, id: number) => t.call("PATCH", `/api/v1/todos/${id}`, { status: "done" });

describe("planned time that repeats with a todo", () => {
  it("comes back on every date of the repeat, on the day of the week it was planned", async () => {
    const t = await makeApp();
    const todo = await mondays(t);
    // Planned on Tuesday for a Monday todo: every Tuesday from then on.
    const res = await plan(t, todo.id, "2026-11-17");
    expect(res.statusCode).toBe(201);
    const series = json<BlockSeries>(res);
    expect(series).toMatchObject({
      todoId: todo.id,
      schedule: { startsOn: "2026-11-17", endsOn: null, startTime: "09:00", durationMinutes: 60 },
      next: { occursOn: "2026-11-17", todo: { id: todo.id }, ownerTodoId: todo.id },
    });
    expect(series.schedule.text).toBe("every week on Tue, 09:00–10:00");
    expect(await dates(t)).toEqual([
      `2026-11-17 08:00 scheduled #${todo.id}`,
      `2026-11-24 08:00 scheduled #${todo.id}`,
      `2026-12-01 08:00 scheduled #${todo.id}`,
    ]);
    expect(json<BlockSeries>(await t.call("GET", `/api/v1/todos/${todo.id}/plan`)).todoId).toBe(todo.id);
  });

  it("keeps planning when one date is done: the next todo owns it, the done date stays done", async () => {
    const t = await makeApp();
    const first = await mondays(t);
    await plan(t, first.id, "2026-11-16");
    t.setNow("2026-11-16T12:00:00.000Z");
    const next = json<Todo>(await done(t, first.id)).nextOccurrence;
    expect(next).not.toBeNull();
    const second = next?.id as number;
    expect(await dates(t)).toEqual([
      `2026-11-16 08:00 scheduled #${first.id} done`,
      `2026-11-23 08:00 scheduled #${second}`,
      `2026-11-30 08:00 scheduled #${second}`,
    ]);
    // Any todo of the repeat finds the planned time; it belongs to the open one.
    expect(json<BlockSeries>(await t.call("GET", `/api/v1/todos/${first.id}/plan`)).todoId).toBe(second);

    // Undoing the done takes the untouched next todo back, and the planned time with it.
    await t.call("PATCH", `/api/v1/todos/${first.id}`, { status: "open" });
    expect(json<BlockSeries>(await t.call("GET", `/api/v1/todos/${first.id}/plan`)).todoId).toBe(first.id);
    expect(await dates(t, "2026-11-16", "2026-11-23")).toEqual([
      `2026-11-16 08:00 scheduled #${first.id}`,
      `2026-11-23 08:00 scheduled #${first.id}`,
    ]);
  });

  it("changes one date, this and following, or all, like a calendar", async () => {
    const t = await makeApp();
    const todo = await mondays(t);
    await plan(t, todo.id, "2026-11-16");
    // This one only: the 23rd moves to the afternoon.
    expect(
      (
        await change(t, todo.id, "2026-11-23", {
          scope: "this",
          startAt: "2026-11-23T13:00:00.000Z",
          endAt: "2026-11-23T14:30:00.000Z",
        })
      ).statusCode,
    ).toBe(200);
    // This and following from the 30th: an hour later and on Wednesdays.
    const following = json<BlockSeries>(
      await change(t, todo.id, "2026-11-30", {
        scope: "following",
        startAt: "2026-12-02T09:00:00.000Z",
        endAt: "2026-12-02T10:00:00.000Z",
      }),
    );
    expect(following.segments.map((s) => `${s.startsOn}..${s.endsOn ?? ""} ${s.text}`)).toEqual([
      "2026-11-16..2026-11-29 every week on Mon until 29.11.2026, 09:00–10:00",
      "2026-12-02.. every week on Wed, 10:00–11:00",
    ]);
    expect(await dates(t)).toEqual([
      `2026-11-16 08:00 scheduled #${todo.id}`,
      `2026-11-23 13:00 moved #${todo.id}`,
      `2026-12-02 09:00 scheduled #${todo.id}`,
    ]);
    // Cancel this one, then everything from the 9th on.
    await change(t, todo.id, "2026-12-02", { scope: "this", cancelled: true });
    await change(t, todo.id, "2026-12-09", { scope: "following", cancelled: true });
    expect(await dates(t, "2026-11-30", "2026-12-20", "&cancelled=true")).toEqual([
      `2026-12-02 09:00 cancelled #${todo.id}`,
    ]);
    // All: the whole planned time goes, the todo stays.
    expect((await t.call("DELETE", `/api/v1/todos/${todo.id}/plan`)).statusCode).toBe(204);
    expect(await dates(t)).toEqual([]);
    expect((await t.call("GET", `/api/v1/todos/${todo.id}`)).statusCode).toBe(200);
    expect((await t.call("GET", `/api/v1/todos/${todo.id}/plan`)).statusCode).toBe(404);
  });

  it("ends today when the repeat stops; past dates stay as history", async () => {
    const t = await makeApp();
    const todo = await mondays(t, { dueOn: "2026-11-09" });
    await plan(t, todo.id, "2026-11-09");
    t.setNow("2026-11-24T10:00:00.000Z");
    await t.call("PATCH", `/api/v1/todos/${todo.id}`, { recurrence: null });
    expect(await dates(t, "2026-11-02", "2026-12-13")).toEqual([
      `2026-11-09 08:00 scheduled #${todo.id}`,
      `2026-11-16 08:00 scheduled #${todo.id}`,
      `2026-11-23 08:00 scheduled #${todo.id}`,
    ]);
  });

  it("is only for repeats on a schedule, once per repeat, and not after it ended", async () => {
    const t = await makeApp();
    const single = await t.create<Todo>("/api/v1/todos", { title: "Once", dueOn: "2026-11-16" });
    expect((await plan(t, single.id, "2026-11-16")).json().error.message).toMatch(/does not repeat/);
    const afterDone = await t.create<Todo>("/api/v1/todos", {
      title: "Water plants",
      dueOn: "2026-11-16",
      recurrence: { every: "day", interval: 3, basis: "done" },
    });
    const res = await plan(t, afterDone.id, "2026-11-16");
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/counted from the day it is done/);

    const todo = await mondays(t);
    await plan(t, todo.id, "2026-11-16");
    expect((await plan(t, todo.id, "2026-11-23")).statusCode).toBe(409);

    const last = await mondays(t, { title: "Last one", recurrence: { every: "week", until: "2026-11-20" } });
    await done(t, last.id);
    expect((await plan(t, last.id, "2026-11-16")).json().error.message).toMatch(/has ended/);
  });

  it("goes with the todo when the open todo is deleted", async () => {
    const t = await makeApp();
    const todo = await mondays(t);
    await plan(t, todo.id, "2026-11-16");
    await t.call("DELETE", `/api/v1/todos/${todo.id}`);
    expect(await dates(t)).toEqual([]);
  });
});

describe("GET /todos/recurring", () => {
  it("lists every repeat once with its next date, history and planned time, ended ones last", async () => {
    const t = await makeApp();
    const report = await mondays(t);
    await plan(t, report.id, "2026-11-16");
    const daily = await t.create<Todo>("/api/v1/todos", {
      title: "Inbox zero",
      dueOn: "2026-11-11",
      recurrence: { every: "day" },
    });
    const ended = await mondays(t, { title: "Course", recurrence: { every: "week", until: "2026-11-20" } });
    await t.create<Todo>("/api/v1/todos", { title: "Not repeating", dueOn: "2026-11-12" });
    // Done twice: the daily repeat moves on and stays in the list.
    t.setNow("2026-11-11T16:00:00.000Z");
    const second = json<Todo>(await done(t, daily.id)).nextOccurrence?.id as number;
    t.setNow("2026-11-12T16:00:00.000Z");
    const third = json<Todo>(await done(t, second)).nextOccurrence?.id as number;
    await done(t, ended.id);

    const list = json<RecurringTodo[]>(await t.call("GET", "/api/v1/todos/recurring"));
    expect(
      list.map((r) => [r.todo.title, r.todo.id, r.text, r.nextOn, r.ended, r.doneCount, r.lastDoneAt]),
    ).toEqual([
      ["Inbox zero", third, "every day", "2026-11-13", false, 2, "2026-11-12T16:00:00.000Z"],
      ["Team report", report.id, "every week on Mon", "2026-11-16", false, 0, null],
      ["Course", ended.id, "every week on Mon until 20.11.2026", null, true, 1, "2026-11-12T16:00:00.000Z"],
    ]);
    expect(list[1]?.plan?.schedule.text).toBe("every week on Mon, 09:00–10:00");
    expect(list[0]?.plan).toBeNull();
  });
});
