import type { Meeting, MeetingTodo, MeetingTodos, Project, Todo, TodoMeeting } from "@organizer/shared";
import { describe, expect, it } from "vitest";
import { json, makeApp, type TestApp } from "./helpers.ts";

// The test clock starts on Wednesday 11.11.2026 at 11:00 in Zurich (10:00 UTC). Both meetings are on
// Thursdays from 12.11.2026: the standup at 09:00, the review at 14:00.

type Caller = Pick<TestApp, "call" | "create">;

const meeting = (t: Caller, name: string, more: Record<string, unknown> = {}) =>
  t.create<Meeting>("/api/v1/meetings", {
    name,
    schedule: { rule: { every: "week" }, startsOn: "2026-11-12", startTime: "09:00", durationMinutes: 15 },
    ...more,
  });

const todo = (t: Caller, title: string, more: Record<string, unknown> = {}) =>
  t.create<Todo>("/api/v1/todos", { title, ...more });

const add = (t: Caller, meetingId: number, todoId: number) =>
  t.call("POST", `/api/v1/meetings/${meetingId}/todos`, { todoId });

const todosOf = async (t: Caller, meetingId: number) =>
  json<MeetingTodos>(await t.call("GET", `/api/v1/meetings/${meetingId}/todos`));

const titles = async (t: Caller, meetingId: number) =>
  (await todosOf(t, meetingId)).items.map((i) => i.todo.title);

const meetingsOf = async (t: Caller, todoId: number) =>
  json<TodoMeeting[]>(await t.call("GET", `/api/v1/todos/${todoId}/meetings`));

const dueAtNext = (t: Caller, meetingId: number, todoId: number) =>
  t.call("POST", `/api/v1/meetings/${meetingId}/todos/${todoId}/due`);

const getTodo = async (t: Caller, id: number) => json<Todo>(await t.call("GET", `/api/v1/todos/${id}`));

describe("todos added to a meeting", () => {
  it("adds a todo with its project and parent, first added first, and leaves its due date alone", async () => {
    const t = await makeApp();
    const lab = await t.create<Project>("/api/v1/projects", { name: "Lab" });
    const { id } = await meeting(t, "Weekly Standup");
    const budget = await todo(t, "Budget", { projectId: lab.id, dueOn: "2026-12-24" });
    const parent = await todo(t, "Rack");
    const [child] = json<Todo[]>(
      await t.call("POST", `/api/v1/todos/${parent.id}/subtasks`, { titles: ["Cables"] }),
    );
    const added = await add(t, id, budget.id);
    expect(added.statusCode).toBe(201);
    expect(json<MeetingTodo>(added)).toEqual({
      todo: { id: budget.id, title: "Budget", status: "open" },
      project: { id: lab.id, slug: "lab", name: "Lab", color: lab.color },
      parent: null,
      dueOn: "2026-12-24",
      addedAt: "2026-11-11T10:00:00.000Z",
    });
    t.advance(60_000);
    await add(t, id, (child as Todo).id);
    const list = await todosOf(t, id);
    expect(list.meetingId).toBe(id);
    expect(list.nextOn).toBe("2026-11-12");
    expect(list.items.map((i) => [i.todo.title, i.parent?.title ?? null])).toEqual([
      ["Budget", null],
      ["Cables", "Rack"],
    ]);
    // Adding never changes the due date.
    expect((await getTodo(t, budget.id)).dueOn).toBe("2026-12-24");
    expect((await getTodo(t, (child as Todo).id)).dueOn).toBeNull();
  });

  it("refuses adding a todo twice, unknown todos and unknown meetings", async () => {
    const t = await makeApp();
    const { id } = await meeting(t, "Review");
    const task = await todo(t, "Slides");
    expect((await add(t, id, task.id)).statusCode).toBe(201);
    const twice = await add(t, id, task.id);
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.message).toBe(`Todo ${task.id} is on this meeting already.`);
    expect(await titles(t, id)).toEqual(["Slides"]);
    const unknown = await add(t, id, 99);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.message).toBe("Todo 99 does not exist. Check the id.");
    expect((await add(t, 42, task.id)).statusCode).toBe(404);
    expect((await t.call("GET", "/api/v1/meetings/42/todos")).statusCode).toBe(404);
    expect((await t.call("POST", `/api/v1/meetings/${id}/todos`, { todoId: task.id, x: 1 })).statusCode).toBe(
      422,
    );
  });

  it("keeps a todo on every date, through ticks, standup rules and done, until it is removed", async () => {
    const t = await makeApp();
    const standup = await meeting(t, "Weekly Standup");
    const topic = await todo(t, "Hiring");
    await t.call("PATCH", `/api/v1/todos/${topic.id}`, { status: "in_progress" });
    await add(t, standup.id, topic.id);
    // It is on the worked-out list too; ticking it there does not take it off the meeting.
    const list = json<{ items: { todo: { id: number }; at: string }[] }>(
      await t.call("GET", `/api/v1/meetings/${standup.id}/standup`),
    );
    const listed = list.items.find((i) => i.todo.id === topic.id);
    expect(listed).toBeDefined();
    await t.call("POST", `/api/v1/meetings/${standup.id}/standup/marks`, {
      on: "2026-11-12",
      marks: [{ todoId: topic.id, kind: "said", coveredUntil: listed?.at }],
    });
    await t.call("PATCH", `/api/v1/todos/${topic.id}`, { status: "done" });
    // A month later, on another date: still there.
    t.setNow("2026-12-10T10:00:00.000Z");
    expect(await titles(t, standup.id)).toEqual(["Hiring"]);
    expect((await todosOf(t, standup.id)).items[0]?.todo.status).toBe("done");

    const removed = await t.call("DELETE", `/api/v1/meetings/${standup.id}/todos/${topic.id}`);
    expect(removed.statusCode).toBe(204);
    expect(await titles(t, standup.id)).toEqual([]);
    expect((await getTodo(t, topic.id)).title).toBe("Hiring");
    const again = await t.call("DELETE", `/api/v1/meetings/${standup.id}/todos/${topic.id}`);
    expect(again.statusCode).toBe(404);
    expect(again.json().error.message).toBe(
      `Todo ${topic.id} is not on meeting ${standup.id}. Check the ids.`,
    );
  });

  it("shows on a todo every meeting it is on, the next one first", async () => {
    const t = await makeApp();
    const review = await meeting(t, "Review", {
      schedule: { rule: { every: "week" }, startsOn: "2026-11-13", startTime: "14:00", durationMinutes: 60 },
    });
    const standup = await meeting(t, "Weekly Standup");
    const ended = await meeting(t, "Kickoff", {
      schedule: {
        rule: { every: "week" },
        startsOn: "2026-11-05",
        endsOn: "2026-11-05",
        startTime: "09:00",
        durationMinutes: 30,
      },
    });
    const task = await todo(t, "Budget");
    await Promise.all([review, ended, standup].map((m) => add(t, m.id, task.id)));
    expect((await meetingsOf(t, task.id)).map((m) => [m.meeting.name, m.meeting.type, m.nextOn])).toEqual([
      ["Weekly Standup", "standup", "2026-11-12"],
      ["Review", "other", "2026-11-13"],
      ["Kickoff", "other", null],
    ]);
    expect(await meetingsOf(t, (await todo(t, "Other")).id)).toEqual([]);
    expect((await t.call("GET", "/api/v1/todos/99/meetings")).statusCode).toBe(404);
  });

  it("drops the link when the todo or the meeting is deleted, and keeps the other side", async () => {
    const t = await makeApp();
    const standup = await meeting(t, "Weekly Standup");
    const review = await meeting(t, "Review");
    const gone = await todo(t, "Gone");
    const stays = await todo(t, "Stays");
    await add(t, standup.id, gone.id);
    await add(t, standup.id, stays.id);
    await add(t, review.id, stays.id);
    await t.call("DELETE", `/api/v1/todos/${gone.id}`);
    expect(await titles(t, standup.id)).toEqual(["Stays"]);
    await t.call("DELETE", `/api/v1/meetings/${standup.id}`);
    expect((await meetingsOf(t, stays.id)).map((m) => m.meeting.name)).toEqual(["Review"]);
    expect((await getTodo(t, stays.id)).title).toBe("Stays");
    // Adding the deleted todo again is refused like any unknown todo.
    expect((await add(t, review.id, gone.id)).statusCode).toBe(404);
  });

  it("takes at most 100 todos per meeting", async () => {
    const t = await makeApp();
    const { id } = await meeting(t, "Review");
    const sqlite = t.deps.db.$client;
    const T = "2026-11-11T10:00:00.000Z";
    const insertTodo = sqlite.prepare(
      "INSERT INTO todos (account_id, id, title, created_at, updated_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const link = sqlite.prepare(
      "INSERT INTO meeting_todos (account_id, meeting_id, todo_id, added_at) VALUES (?, ?, ?, ?)",
    );
    for (let k = 1; k <= 100; k += 1) {
      insertTodo.run(t.account.id, 1000 + k, `Topic ${k}`, T, T, T);
      link.run(t.account.id, id, 1000 + k, T);
    }
    const task = await todo(t, "One more");
    const over = await add(t, id, task.id);
    expect(over.statusCode).toBe(422);
    expect(over.json().error.message).toBe("A meeting can have at most 100 todos. Remove one first.");
    expect((await todosOf(t, id)).items).toHaveLength(100);
    // Another meeting still takes it.
    expect((await add(t, (await meeting(t, "Other")).id, task.id)).statusCode).toBe(201);
  });
});

describe("due at next meeting", () => {
  it("sets the due date to the next date, never by itself", async () => {
    const t = await makeApp();
    const { id } = await meeting(t, "Weekly Standup");
    const task = await todo(t, "Budget", { dueOn: "2026-12-24" });
    await add(t, id, task.id);
    expect((await getTodo(t, task.id)).dueOn).toBe("2026-12-24");
    const res = await dueAtNext(t, id, task.id);
    expect(res.statusCode).toBe(200);
    expect(json<Todo>(res).dueOn).toBe("2026-11-12");
    expect((await todosOf(t, id)).items[0]?.dueOn).toBe("2026-11-12");
    const history = json<{ items: { type: string; event?: { kind: string } }[] }>(
      await t.call("GET", `/api/v1/todos/${task.id}/activity`),
    ).items.map((i) => i.event?.kind);
    expect(history).toContain("dates_changed");
    // After this week's meeting has ended, the next one is a week later.
    t.setNow("2026-11-12T08:30:00.000Z");
    expect((await todosOf(t, id)).nextOn).toBe("2026-11-19");
    expect(json<Todo>(await dueAtNext(t, id, task.id)).dueOn).toBe("2026-11-19");
  });

  it("skips a cancelled next date and takes the day a moved one went to", async () => {
    const t = await makeApp();
    const { id } = await meeting(t, "Weekly Standup");
    const task = await todo(t, "Budget");
    await add(t, id, task.id);
    await t.call("PATCH", `/api/v1/meetings/${id}/occurrences/2026-11-12`, {
      scope: "this",
      cancelled: true,
    });
    expect((await todosOf(t, id)).nextOn).toBe("2026-11-19");
    expect(json<Todo>(await dueAtNext(t, id, task.id)).dueOn).toBe("2026-11-19");
    await t.call("PATCH", `/api/v1/meetings/${id}/occurrences/2026-11-19`, {
      scope: "this",
      startAt: "2026-11-17T13:00:00.000Z",
      endAt: "2026-11-17T13:15:00.000Z",
    });
    expect(json<Todo>(await dueAtNext(t, id, task.id)).dueOn).toBe("2026-11-17");
    expect((await meetingsOf(t, task.id))[0]?.nextOn).toBe("2026-11-17");
  });

  it("refuses when the meeting has no next date or the todo is not on it", async () => {
    const t = await makeApp();
    const ended = await meeting(t, "Kickoff", {
      schedule: {
        rule: { every: "week" },
        startsOn: "2026-11-05",
        endsOn: "2026-11-05",
        startTime: "09:00",
        durationMinutes: 30,
      },
    });
    const task = await todo(t, "Budget", { dueOn: "2026-12-24" });
    await add(t, ended.id, task.id);
    expect((await todosOf(t, ended.id)).nextOn).toBeNull();
    const none = await dueAtNext(t, ended.id, task.id);
    expect(none.statusCode).toBe(409);
    expect(none.json().error.message).toBe(
      "Kickoff has no next date, so there is no day to set as due date.",
    );
    // The only date left is cancelled: no next date either.
    const once = await meeting(t, "Offsite", {
      schedule: {
        rule: { every: "week" },
        startsOn: "2026-11-12",
        endsOn: "2026-11-12",
        startTime: "09:00",
        durationMinutes: 30,
      },
    });
    await add(t, once.id, task.id);
    await t.call("PATCH", `/api/v1/meetings/${once.id}/occurrences/2026-11-12`, {
      scope: "this",
      cancelled: true,
    });
    expect((await dueAtNext(t, once.id, task.id)).statusCode).toBe(409);
    expect((await getTodo(t, task.id)).dueOn).toBe("2026-12-24");
    const other = await todo(t, "Not on it");
    const missing = await dueAtNext(t, once.id, other.id);
    expect(missing.statusCode).toBe(404);
    expect((await getTodo(t, other.id)).dueOn).toBeNull();
  });
});

describe("other accounts", () => {
  it("get 404 for another account's meeting and todo, and cannot add its todos to their meetings", async () => {
    const t = await makeApp();
    const anna = await meeting(t, "Weekly Standup");
    // Anna's second todo has an id Bobby does not have.
    await todo(t, "First");
    const secret = await todo(t, "Secret topic");
    await add(t, anna.id, secret.id);
    const bobby = await t.asAccount({ username: "bobby" });
    const own = await meeting(bobby, "Bobby's standup");
    const mine = await todo(bobby, "Mine");
    // Bobby's meeting #1 and todo #1 are his own; Anna's meeting #1 and todo #2 stay hers.
    expect(own.id).toBe(anna.id);
    const calls: [string, number][] = [
      ["POST own meeting, Anna's todo", (await add(bobby, own.id, secret.id)).statusCode],
      [
        "GET Anna's todo meetings",
        (await bobby.call("GET", `/api/v1/todos/${secret.id}/meetings`)).statusCode,
      ],
      [
        "DELETE Anna's link",
        (await bobby.call("DELETE", `/api/v1/meetings/${own.id}/todos/${secret.id}`)).statusCode,
      ],
      ["due on Anna's todo", (await dueAtNext(bobby, own.id, secret.id)).statusCode],
    ];
    expect(calls.filter(([, code]) => code !== 404)).toEqual([]);
    expect((await todosOf(bobby, own.id)).items).toEqual([]);
    expect(await titles(t, anna.id)).toEqual(["Secret topic"]);
    // Bobby's own todo on his own meeting works and does not show on Anna's side.
    expect((await add(bobby, own.id, mine.id)).statusCode).toBe(201);
    expect(await titles(t, anna.id)).toEqual(["Secret topic"]);
    expect(await meetingsOf(t, mine.id)).toEqual([]);
  });
});
