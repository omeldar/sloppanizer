import type { Meeting, MeetingNote, Note, Project, Standup, StandupItem, Todo } from "@organizer/shared";
import { describe, expect, it } from "vitest";
import { json, makeApp, type TestActor, type TestApp } from "./helpers.ts";

// The test clock starts on Wednesday 11.11.2026, 10:00 UTC. The standup is on Thursdays at 09:00 in
// Zurich from 12.11.; its first window starts on Thursday 05.11. at 09:00 (08:00 UTC).

const SINCE = "2026-11-05T08:00:00.000Z";

type Caller = Pick<TestApp, "call" | "create">;

const createStandup = (t: Caller, more: Record<string, unknown> = {}) =>
  t.create<Meeting>("/api/v1/meetings", {
    name: "Weekly Standup",
    schedule: { rule: { every: "week" }, startsOn: "2026-11-12", startTime: "09:00", durationMinutes: 15 },
    ...more,
  });

const todo = (t: Caller, title: string, more: Record<string, unknown> = {}) =>
  t.create<Todo>("/api/v1/todos", { title, ...more });

const setStatus = (t: Caller, id: number, status: string) =>
  t.call("PATCH", `/api/v1/todos/${id}`, { status });

const comment = (t: Caller, id: number, bodyMd: string) =>
  t.call("POST", `/api/v1/todos/${id}/comments`, { bodyMd });

const list = async (t: Caller, meetingId: number, query = "") =>
  json<Standup>(await t.call("GET", `/api/v1/meetings/${meetingId}/standup${query}`));

/** "kind title" per item, in list order. */
const lines = (standup: Standup) => standup.items.map((i) => `${i.kind} ${i.todo.title}`);

const item = (standup: Standup, title: string) =>
  standup.items.find((i) => i.todo.title === title) as StandupItem;

const mark = (t: Caller, meetingId: number, on: string, marks: unknown[]) =>
  t.call("POST", `/api/v1/meetings/${meetingId}/standup/marks`, { on, marks });

/** Marks the items as the list showed them (coveredUntil = their at). */
const say = (t: Caller, meetingId: number, standup: Standup, titles: string[], kind = "said") =>
  mark(
    t,
    meetingId,
    standup.on,
    titles.map((title) => ({
      todoId: item(standup, title).todo.id,
      kind,
      coveredUntil: item(standup, title).at,
    })),
  );

describe("the standup list", () => {
  it("lists done, started, updated and blocked todos of the window, never open ones", async () => {
    const t = await makeApp();
    t.setNow("2026-11-03T10:00:00.000Z");
    const oldDone = await todo(t, "Done before the window");
    await setStatus(t, oldDone.id, "done");
    const oldBlocked = await todo(t, "Blocked before the window");
    await setStatus(t, oldBlocked.id, "blocked");
    const working = await todo(t, "In progress before");
    await setStatus(t, working.id, "in_progress");
    t.setNow("2026-11-10T10:00:00.000Z");
    const done = await todo(t, "Shipped");
    await setStatus(t, done.id, "done");
    const started = await todo(t, "Started");
    await setStatus(t, started.id, "in_progress");
    const blocked = await todo(t, "Waiting for parts");
    await setStatus(t, blocked.id, "blocked");
    await comment(t, working.id, "Halfway there");
    await todo(t, "Still open");
    t.setNow("2026-11-11T10:00:00.000Z");
    const { id } = await createStandup(t);
    const standup = await list(t, id);
    expect(standup).toMatchObject({
      meetingId: id,
      on: "2026-11-12",
      since: SINCE,
      said: [],
      dismissedCount: 0,
    });
    expect(lines(standup)).toEqual([
      "done Shipped",
      "started Started",
      "updated In progress before",
      "blocked Waiting for parts",
    ]);
    expect(standup.counts).toEqual({ done: 1, started: 1, updated: 1, blocked: 1 });
    expect(item(standup, "Shipped").at).toBe("2026-11-10T10:00:00.000Z");
    expect(item(standup, "Started").changes).toEqual(["changed status from Open to In progress"]);
    expect(item(standup, "In progress before")).toMatchObject({
      newCommentCount: 1,
      lastComment: { actor: "you", excerpt: "Halfway there" },
      again: false,
    });
    expect(json<Meeting>(await t.call("GET", `/api/v1/meetings/${id}`)).openCount).toBe(4);
  });

  it("shows every todo in progress on a new standup, also one untouched for a month", async () => {
    const t = await makeApp();
    t.setNow("2026-10-01T10:00:00.000Z");
    const quiet = await todo(t, "Long task");
    await setStatus(t, quiet.id, "in_progress");
    t.setNow("2026-11-11T10:00:00.000Z");
    const { id } = await createStandup(t);
    const first = await list(t, id);
    expect(lines(first)).toEqual(["started Long task"]);
    expect(item(first, "Long task").at).toBe("2026-10-01T10:00:00.000Z");
    // Not said at the first standup: it is still there a week later.
    t.setNow("2026-11-19T10:00:00.000Z");
    const next = await list(t, id);
    expect(next.on).toBe("2026-11-19");
    expect(lines(next)).toEqual(["started Long task"]);
    expect((await say(t, id, next, ["Long task"])).statusCode).toBe(200);
    expect(lines(await list(t, id))).toEqual([]);
    // A due date alone is no update; a new subtask is.
    await t.call("PATCH", `/api/v1/todos/${quiet.id}`, { dueOn: "2026-12-01" });
    expect(lines(await list(t, id))).toEqual([]);
    await t.call("POST", `/api/v1/todos/${quiet.id}/subtasks`, { titles: ["Part one"] });
    const back = await list(t, id);
    expect(lines(back)).toEqual(["updated Long task"]);
    expect(item(back, "Long task")).toMatchObject({ again: true, changes: ["added subtask #2"] });
  });

  it("shows a todo again when a comment comes after it was said", async () => {
    const t = await makeApp();
    const { id } = await createStandup(t);
    const task = await todo(t, "Firewall");
    await setStatus(t, task.id, "blocked");
    const shown = await list(t, id);
    expect(lines(shown)).toEqual(["blocked Firewall"]);
    await say(t, id, shown, ["Firewall"]);
    const after = await list(t, id);
    expect(lines(after)).toEqual([]);
    expect(after.said.map((s) => [s.todo.title, s.markedAt])).toEqual([
      ["Firewall", "2026-11-11T10:00:00.000Z"],
    ]);
    t.advance(60_000);
    await comment(t, task.id, "Still waiting for the vendor");
    const again = await list(t, id);
    expect(lines(again)).toEqual(["blocked Firewall"]);
    expect(item(again, "Firewall")).toMatchObject({ again: true, newCommentCount: 1, changes: [] });
  });

  it("keeps a todo when a comment came between showing the list and ticking it", async () => {
    const t = await makeApp();
    const { id } = await createStandup(t);
    const task = await todo(t, "Backup");
    await setStatus(t, task.id, "in_progress");
    const shown = await list(t, id);
    t.advance(60_000);
    await comment(t, task.id, "Restore test failed");
    t.advance(60_000);
    await say(t, id, shown, ["Backup"]);
    const after = await list(t, id);
    expect(lines(after)).toEqual(["updated Backup"]);
    expect(item(after, "Backup").lastComment?.excerpt).toBe("Restore test failed");
  });

  it("covers at most until now, so later activity still counts", async () => {
    const t = await makeApp();
    const { id } = await createStandup(t);
    const task = await todo(t, "Certs");
    await setStatus(t, task.id, "blocked");
    await mark(t, id, "2026-11-12", [
      { todoId: task.id, kind: "said", coveredUntil: "2027-01-01T00:00:00.000Z" },
    ]);
    expect(lines(await list(t, id))).toEqual([]);
    t.advance(60_000);
    await comment(t, task.id, "Renewed one of two");
    expect(lines(await list(t, id))).toEqual(["blocked Certs"]);
  });

  it("never covers less when a date is marked again with an older time", async () => {
    const t = await makeApp();
    const { id } = await createStandup(t);
    const task = await todo(t, "Switch");
    await setStatus(t, task.id, "in_progress");
    const first = await list(t, id);
    t.advance(60_000);
    await comment(t, task.id, "Ordered");
    const second = await list(t, id);
    await say(t, id, second, ["Switch"]);
    expect(lines(await list(t, id))).toEqual([]);
    // An old list (from before the comment) dismisses it on the same date: the comment stays covered.
    await say(t, id, first, ["Switch"], "dismissed");
    const after = await list(t, id);
    expect(lines(after)).toEqual([]);
    expect(after.dismissedCount).toBe(1);
    const row = t.deps.db.$client
      .prepare("SELECT covered_until FROM standup_marks WHERE todo_id = ?")
      .get(task.id) as { covered_until: string };
    expect(row.covered_until).toBe(item(second, "Switch").at);
  });

  it("dismisses an item without saying it; it comes back on new updates", async () => {
    const t = await makeApp();
    const { id } = await createStandup(t);
    const task = await todo(t, "Tidy cables");
    await setStatus(t, task.id, "in_progress");
    await say(t, id, await list(t, id), ["Tidy cables"], "dismissed");
    const after = await list(t, id);
    expect(after).toMatchObject({ items: [], said: [], dismissedCount: 1 });
    t.advance(60_000);
    await setStatus(t, task.id, "done");
    expect(lines(await list(t, id))).toEqual(["done Tidy cables"]);
  });

  it("does not bring a said done todo back for a comment", async () => {
    const t = await makeApp();
    const { id } = await createStandup(t);
    const task = await todo(t, "Release");
    await setStatus(t, task.id, "done");
    await say(t, id, await list(t, id), ["Release"]);
    t.advance(60_000);
    await comment(t, task.id, "Release notes are out");
    expect(lines(await list(t, id))).toEqual([]);
  });

  it("undoes a mark", async () => {
    const t = await makeApp();
    const { id } = await createStandup(t);
    const task = await todo(t, "Docs");
    await setStatus(t, task.id, "done");
    await say(t, id, await list(t, id), ["Docs"]);
    expect(lines(await list(t, id))).toEqual([]);
    const url = `/api/v1/meetings/${id}/standup/marks/2026-11-12/${task.id}`;
    expect((await t.call("DELETE", url)).statusCode).toBe(204);
    expect(lines(await list(t, id))).toEqual(["done Docs"]);
    expect((await t.call("DELETE", url)).statusCode).toBe(404);
  });

  it("follows the standup's filter and the kinds asked for", async () => {
    const t = await makeApp();
    const lab = await t.create<Project>("/api/v1/projects", { name: "Lab" });
    const home = await t.create<Project>("/api/v1/projects", { name: "Home" });
    const ops = await t.create<{ id: number }>("/api/v1/labels", { name: "ops" });
    await t.create("/api/v1/labels", { name: "misc" });
    const make = async (title: string, more: Record<string, unknown>, status: string) =>
      setStatus(t, (await todo(t, title, more)).id, status);
    await make("Lab ops", { projectId: lab.id, labels: ["ops"] }, "done");
    await make("Lab misc", { projectId: lab.id, labels: ["misc"] }, "done");
    await make("Home ops", { projectId: home.id, labels: ["ops"] }, "blocked");
    await make("Inbox ops", { labels: ["ops"] }, "in_progress");
    await make("Inbox plain", {}, "in_progress");
    const { id } = await createStandup(t, {
      filter: { projectIds: [lab.id], inbox: true, labelIds: [ops.id] },
    });
    expect(lines(await list(t, id))).toEqual(["done Lab ops", "started Inbox ops"]);
    const everything = await createStandup(t, { name: "Daily" });
    const all = await list(t, everything.id, "?kind=done,blocked");
    expect(lines(all)).toEqual(["done Lab misc", "done Lab ops", "blocked Home ops"]);
    expect(all.counts).toEqual({ done: 2, started: 2, updated: 0, blocked: 1 });
    // A deleted project in the filter matches nothing; it does not turn into "everything".
    const only = await createStandup(t, { name: "Home standup", filter: { projectIds: [home.id] } });
    await t.call("DELETE", `/api/v1/projects/${home.id}`);
    expect(lines(await list(t, only.id))).toEqual([]);
  });

  it("lists subtasks as their own items with the parent", async () => {
    const t = await makeApp();
    const { id } = await createStandup(t);
    const parent = await todo(t, "Rack");
    const [child] = json<Todo[]>(
      await t.call("POST", `/api/v1/todos/${parent.id}/subtasks`, { titles: ["Cables"] }),
    );
    await setStatus(t, (child as Todo).id, "done");
    const standup = await list(t, id);
    expect(lines(standup)).toEqual(["done Cables"]);
    expect(item(standup, "Cables").parent).toEqual({ id: parent.id, title: "Rack", status: "open" });
  });

  it("keeps marks per standup", async () => {
    const t = await makeApp();
    const team = await createStandup(t);
    const other = await createStandup(t, { name: "Daily" });
    const task = await todo(t, "Upgrade");
    await setStatus(t, task.id, "done");
    await say(t, team.id, await list(t, team.id), ["Upgrade"]);
    expect(lines(await list(t, team.id))).toEqual([]);
    expect(lines(await list(t, other.id))).toEqual(["done Upgrade"]);
  });

  it("refuses lists of other meetings, foreign todos and dates the meeting does not have", async () => {
    const t = await makeApp();
    const retro = await createStandup(t, { name: "Retro" });
    const res = await t.call("GET", `/api/v1/meetings/${retro.id}/standup`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/Only standups have a list/);
    const { id } = await createStandup(t);
    const task = await todo(t, "Mine");
    const noDate = await mark(t, id, "2026-11-13", [{ todoId: task.id, kind: "said", coveredUntil: SINCE }]);
    expect(noDate.statusCode).toBe(404);
    const missing = await mark(t, id, "2026-11-12", [{ todoId: 99, kind: "said", coveredUntil: SINCE }]);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.message).toBe("Todo 99 does not exist. Check the id.");
  });
});

describe("other accounts", () => {
  it("cannot read or mark another account's standup or todos", async () => {
    const t = await makeApp();
    await createStandup(t, { name: "First" });
    // Anna's standup #2; Bobby only has a #1 of his own.
    const { id } = await createStandup(t);
    const task = await todo(t, "Anna's secret");
    await setStatus(t, task.id, "done");
    const secretNote = await t.create<Note>("/api/v1/notes", { title: "Anna's note" });
    const bobby: TestActor = await t.asAccount({ username: "bobby" });
    const own = await createStandup(bobby);
    const calls = [
      await bobby.call("GET", `/api/v1/meetings/${id}/standup`),
      await bobby.call("POST", `/api/v1/meetings/${id}/standup/marks`, {
        on: "2026-11-12",
        marks: [{ todoId: task.id, kind: "said", coveredUntil: SINCE }],
      }),
      // Bobby's own standup with Anna's todo id (Bobby has no todo with that id).
      await bobby.call("POST", `/api/v1/meetings/${own.id}/standup/marks`, {
        on: "2026-11-12",
        marks: [{ todoId: task.id, kind: "said", coveredUntil: SINCE }],
      }),
      await bobby.call("DELETE", `/api/v1/meetings/${id}/standup/marks/2026-11-12/${task.id}`),
      await bobby.call("GET", `/api/v1/meetings/${id}/notes`),
      await bobby.call("POST", `/api/v1/meetings/${id}/notes`, { on: "2026-11-12" }),
      // Bobby's own standup with Anna's note id.
      await bobby.call("POST", `/api/v1/meetings/${own.id}/notes`, {
        on: "2026-11-12",
        noteId: secretNote.id,
      }),
    ];
    expect(calls.map((r) => r.statusCode)).toEqual([404, 404, 404, 404, 404, 404, 404]);
    expect(calls.map((r) => r.body).join(" ")).not.toContain("Anna");
    expect(lines(await list(bobby, own.id))).toEqual([]);
    expect(lines(await list(t, id))).toEqual(["done Anna's secret"]);
  });
});

describe("a note per meeting date", () => {
  it("writes a note for a date, links another one and unlinks without deleting", async () => {
    const t = await makeApp();
    const { id } = await createStandup(t);
    const created = await t.create<MeetingNote>(`/api/v1/meetings/${id}/notes`, { on: "2026-11-12" });
    expect(created).toMatchObject({
      meetingId: id,
      on: "2026-11-12",
      note: { title: "Weekly Standup 12.11.2026" },
    });
    const again = await t.call("POST", `/api/v1/meetings/${id}/notes`, { on: "2026-11-12" });
    expect(again.statusCode).toBe(409);
    const own = await t.create<Note>("/api/v1/notes", { title: "Prep" });
    const linked = await t.create<MeetingNote>(`/api/v1/meetings/${id}/notes`, {
      on: "2026-11-19",
      noteId: own.id,
    });
    expect(linked.note.id).toBe(own.id);
    const twice = await t.call("POST", `/api/v1/meetings/${id}/notes`, { on: "2026-11-26", noteId: own.id });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.message).toBe(
      `Note ${own.id} belongs to Weekly Standup on 19.11.2026 already.`,
    );
    expect(
      (await t.call("POST", `/api/v1/meetings/${id}/notes`, { on: "2026-11-26", noteId: 99 })).statusCode,
    ).toBe(404);
    expect((await t.call("POST", `/api/v1/meetings/${id}/notes`, { on: "2026-11-13" })).statusCode).toBe(404);

    const notes = json<MeetingNote[]>(await t.call("GET", `/api/v1/meetings/${id}/notes`));
    expect(notes.map((n) => [n.on, n.note.title])).toEqual([
      ["2026-11-19", "Prep"],
      ["2026-11-12", "Weekly Standup 12.11.2026"],
    ]);
    const occurrences = json<{ occursOn: string; noteId: number | null }[]>(
      await t.call("GET", `/api/v1/meetings/occurrences?from=2026-11-09&to=2026-11-22`),
    );
    expect(occurrences.map((o) => [o.occursOn, o.noteId])).toEqual([
      ["2026-11-12", created.note.id],
      ["2026-11-19", own.id],
    ]);

    expect((await t.call("DELETE", `/api/v1/meetings/${id}/notes/2026-11-19`)).statusCode).toBe(204);
    expect((await t.call("GET", `/api/v1/notes/${own.id}`)).statusCode).toBe(200);
    expect((await t.call("DELETE", `/api/v1/meetings/${id}/notes/2026-11-19`)).statusCode).toBe(404);
    // Deleting the note removes the link; deleting the meeting keeps the note.
    await t.call("DELETE", `/api/v1/notes/${created.note.id}`);
    expect(json<MeetingNote[]>(await t.call("GET", `/api/v1/meetings/${id}/notes`))).toEqual([]);
    await t.create(`/api/v1/meetings/${id}/notes`, { on: "2026-11-26", noteId: own.id });
    await t.call("DELETE", `/api/v1/meetings/${id}`);
    expect((await t.call("GET", `/api/v1/notes/${own.id}`)).statusCode).toBe(200);
  });
});

describe("what does not count as an update", () => {
  it("keeps said todos hidden after a label, project or due date change, in every status", async () => {
    const t = await makeApp();
    const { id } = await createStandup(t);
    const project = await t.create<Project>("/api/v1/projects", { name: "Lab" });
    await t.create("/api/v1/labels", { name: "ops" });
    const titles = { done: "Done one", blocked: "Blocked one", in_progress: "Working one" };
    for (const [status, title] of Object.entries(titles)) {
      // oxlint-disable-next-line no-await-in-loop -- one todo after the other keeps the clock readable
      await setStatus(t, (await todo(t, title)).id, status);
    }
    const shown = await list(t, id);
    expect(lines(shown)).toHaveLength(3);
    await say(t, id, shown, Object.values(titles));
    t.advance(60_000);
    for (const { todo: ref } of shown.items) {
      // oxlint-disable-next-line no-await-in-loop -- see above
      const res = await t.call("PATCH", `/api/v1/todos/${ref.id}`, {
        labels: ["ops"],
        projectId: project.id,
        dueOn: "2026-12-24",
      });
      expect(res.statusCode).toBe(200);
    }
    expect(lines(await list(t, id))).toEqual([]);
  });

  it("does not show a todo again for a comment on another todo, and never shows open ones", async () => {
    const t = await makeApp();
    const { id } = await createStandup(t);
    const quiet = await todo(t, "Quiet");
    await setStatus(t, quiet.id, "blocked");
    const other = await todo(t, "Other");
    await say(t, id, await list(t, id), ["Quiet"]);
    t.advance(60_000);
    await comment(t, other.id, "Nothing to do with it");
    expect(lines(await list(t, id))).toEqual([]);
  });

  it("brings a todo back for a status change after it was said", async () => {
    const t = await makeApp();
    const { id } = await createStandup(t);
    const task = await todo(t, "Server move");
    await setStatus(t, task.id, "in_progress");
    await say(t, id, await list(t, id), ["Server move"]);
    expect(lines(await list(t, id))).toEqual([]);
    t.advance(60_000);
    await setStatus(t, task.id, "blocked");
    expect(lines(await list(t, id))).toEqual(["blocked Server move"]);
  });
});

describe("two standups", () => {
  it("keeps said and dismissed apart, and both bring the todo back on new updates", async () => {
    const t = await makeApp();
    const team = await createStandup(t);
    const daily = await createStandup(t, { name: "Daily" });
    const task = await todo(t, "Patch day");
    await setStatus(t, task.id, "in_progress");
    await say(t, team.id, await list(t, team.id), ["Patch day"]);
    await say(t, daily.id, await list(t, daily.id), ["Patch day"], "dismissed");
    expect(await list(t, team.id)).toMatchObject({ items: [], dismissedCount: 0 });
    expect(await list(t, daily.id)).toMatchObject({ items: [], dismissedCount: 1, said: [] });
    t.advance(60_000);
    await comment(t, task.id, "Window moved to Friday");
    expect(lines(await list(t, team.id))).toEqual(["updated Patch day"]);
    expect(lines(await list(t, daily.id))).toEqual(["updated Patch day"]);
    // Saying it again in one standup does not touch the other.
    await say(t, team.id, await list(t, team.id), ["Patch day"]);
    expect(lines(await list(t, team.id))).toEqual([]);
    expect(lines(await list(t, daily.id))).toEqual(["updated Patch day"]);
  });
});

describe("subtasks and filters together", () => {
  it("lists an unfinished subtask in progress next to its parent, each as its own item", async () => {
    const t = await makeApp();
    const { id } = await createStandup(t);
    const parent = await todo(t, "Move office");
    await setStatus(t, parent.id, "in_progress");
    const [child] = json<Todo[]>(
      await t.call("POST", `/api/v1/todos/${parent.id}/subtasks`, { titles: ["Pack boxes"] }),
    );
    await setStatus(t, (child as Todo).id, "in_progress");
    const standup = await list(t, id);
    expect(lines(standup).toSorted()).toEqual(["started Move office", "started Pack boxes"]);
    expect(item(standup, "Pack boxes").parent?.title).toBe("Move office");
    expect(item(standup, "Move office").parent).toBeNull();
    // Saying the subtask leaves the parent on the list.
    await say(t, id, standup, ["Pack boxes"]);
    expect(lines(await list(t, id))).toEqual(["started Move office"]);
  });

  it("lists a subtask of a todo in the filtered project", async () => {
    const t = await makeApp();
    const lab = await t.create<Project>("/api/v1/projects", { name: "Lab" });
    const { id } = await createStandup(t, { filter: { projectIds: [lab.id], inbox: false } });
    const inLab = await todo(t, "Lab parent", { projectId: lab.id });
    const [child] = json<Todo[]>(
      await t.call("POST", `/api/v1/todos/${inLab.id}/subtasks`, { titles: ["Lab child"] }),
    );
    await setStatus(t, (child as Todo).id, "done");
    const standup = await list(t, id);
    expect(lines(standup)).toEqual(["done Lab child"]);
    expect(item(standup, "Lab child").todo.id).toBe((child as Todo).id);
  });
});
