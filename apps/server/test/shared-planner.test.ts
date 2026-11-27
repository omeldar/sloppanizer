import type { Activity, Space, TimeBlock, Todo, WorkStats } from "@organizer/shared";
import { describe, expect, it } from "vitest";
import { json, makeApp } from "./helpers.ts";

const H = "x-sloppanizer-space";
const WEEK = "from=2026-11-09&to=2026-11-15";
const SPAN = { startAt: "2026-11-12T08:00:00.000Z", endAt: "2026-11-12T09:30:00.000Z" };

/** Anna owns "Home move" with Bo as a member; Cy is a user outside it. */
async function homeMove() {
  const t = await makeApp({ env: { SLOPPANIZER_PUBLIC_URL: "https://todo.example.com" } });
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
  const blocks = async (who: { call: typeof t.call }, query = `${WEEK}&shared=true`, extra = {}) =>
    json<TimeBlock[]>(await who.call("GET", `/api/v1/blocks?${query}`, undefined, extra));
  const events = async (todoId: number) =>
    json<Activity>(await t.call("GET", `/api/v1/todos/${todoId}/activity`, undefined, headers)).items.flatMap(
      (i) => (i.type === "event" ? [i.event] : []),
    );
  return { t, bo, cy, space, headers, add, blocks, events };
}

describe("planning todos of shared projects", () => {
  it("keeps the block in the project, as the planner's time, and assigns the unassigned todo", async () => {
    const { t, bo, space, headers, add, blocks, events } = await homeMove();
    const todo = await add("Book van");
    const res = await bo.call("POST", "/api/v1/blocks", { todoId: todo.id, ...SPAN }, headers);
    expect(res.statusCode).toBe(201);
    const block = json<TimeBlock>(res);
    const bobo = { accountId: bo.account.id, username: "bobo", name: "bobo" };
    expect(block).toMatchObject({ todoId: todo.id, member: bobo, assignee: bobo, space: null });

    // The todo is planned for that day and Bo's now, both in its history by Bo.
    const after = json<Todo>(await t.call("GET", `/api/v1/todos/${todo.id}`, undefined, headers));
    expect(after.plannedOn).toBe("2026-11-12");
    expect(after.assignee?.username).toBe("bobo");
    const kinds = await events(todo.id);
    expect(kinds.filter((e) => e.kind === "assignee_changed")).toMatchObject([
      { actor: "bobo", data: { from: null, to: { accountId: bo.account.id, name: "bobo" } } },
    ]);

    // Bo's own planner shows it with its project (only when asked for shared blocks); Anna's does not.
    const own = await blocks(bo);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({
      id: block.id,
      todo: { id: todo.id, title: "Book van" },
      space: { id: space.id, name: "Home move" },
      project: { name: "Home move" },
      member: bobo,
    });
    expect(await blocks(bo, WEEK)).toEqual([]);
    expect(await blocks(t)).toEqual([]);
    // Inside the project every member sees it, with whose time it is.
    expect((await blocks(t, WEEK, headers)).map((b) => b.member?.username)).toEqual(["bobo"]);
    // Inside the project shared=true changes nothing (no copies of the same block).
    expect(await blocks(bo, `${WEEK}&shared=true`, headers)).toHaveLength(1);
  });

  it("leaves a todo someone else is on with them, and assigns nothing outside shared projects", async () => {
    const { t, bo, headers, add } = await homeMove();
    const todo = await add("Pack books", { assignee: "anna" });
    const block = json<TimeBlock>(
      await bo.call("POST", "/api/v1/blocks", { todoId: todo.id, ...SPAN }, headers),
    );
    expect(block.member?.username).toBe("bobo");
    expect(block.assignee?.username).toBe("anna");

    // Done todos are not taken on by planning them.
    const done = await add("Old one", { status: "done" });
    const late = json<TimeBlock>(
      await bo.call("POST", "/api/v1/blocks", { todoId: done.id, ...SPAN }, headers),
    );
    expect(late.assignee).toBeNull();

    // Own todos have no assignee, also when planned.
    const mine = await t.create<Todo>("/api/v1/todos", { title: "Mine" });
    const own = await t.create<TimeBlock>("/api/v1/blocks", { todoId: mine.id, ...SPAN });
    expect(own).toMatchObject({ member: null, assignee: null, space: null });
    expect(json<Todo>(await t.call("GET", `/api/v1/todos/${mine.id}`)).assignee).toBeNull();
  });

  it("assigns when a block is given to another todo or the planned day is set", async () => {
    const { t, bo, headers, add } = await homeMove();
    const first = await add("Book van", { assignee: "anna" });
    const block = json<TimeBlock>(
      await bo.call("POST", "/api/v1/blocks", { todoId: first.id, ...SPAN }, headers),
    );
    const second = await add("Call landlord");
    const moved = json<TimeBlock>(
      await bo.call("PATCH", `/api/v1/blocks/${block.id}`, { todoId: second.id }, headers),
    );
    expect(moved.assignee?.username).toBe("bobo");

    // A planned day (the Week view, the todo's Planned field, MCP) assigns too.
    const third = await add("Order boxes");
    const planned = json<Todo>(
      await bo.call("PATCH", `/api/v1/todos/${third.id}`, { plannedOn: "2026-11-13" }, headers),
    );
    expect(planned.assignee?.username).toBe("bobo");
    // Unplanning keeps the assignee; an assignee in the same change wins.
    const fourth = await add("Clean flat");
    const kept = json<Todo>(
      await bo.call(
        "PATCH",
        `/api/v1/todos/${fourth.id}`,
        { plannedOn: "2026-11-13", assignee: null },
        headers,
      ),
    );
    expect(kept.assignee).toBeNull();
    const unplanned = json<Todo>(
      await bo.call("PATCH", `/api/v1/todos/${third.id}`, { plannedOn: null }, headers),
    );
    expect(unplanned.assignee?.username).toBe("bobo");

    // Many at once, and a new todo with a day.
    const fifth = await add("Sell sofa");
    const bulk = json<{ updated: Todo[] }>(
      await t.call(
        "POST",
        "/api/v1/todos/bulk",
        { ids: [fifth.id, fourth.id], patch: { plannedOn: "2026-11-14" } },
        headers,
      ),
    ).updated;
    expect(bulk.map((x) => x.assignee?.username ?? null)).toEqual(["anna", "anna"]);
    const fresh = await add("Return keys", { plannedOn: "2026-11-15" });
    expect(fresh.assignee?.username).toBe("anna");
  });

  it("deletes a member's planned time when they leave, and keeps the others'", async () => {
    const { t, bo, headers, add, blocks } = await homeMove();
    const todo = await add("Book van");
    await bo.call("POST", "/api/v1/blocks", { todoId: todo.id, ...SPAN }, headers);
    await t.call("POST", "/api/v1/blocks", { title: "Measure rooms", ...SPAN }, headers);
    expect(await blocks(t, WEEK, headers)).toHaveLength(2);
    expect(
      (await bo.call("DELETE", `/api/v1/spaces/${headers[H]}/members/${bo.account.id}`)).statusCode,
    ).toBe(204);
    expect((await blocks(t, WEEK, headers)).map((b) => b.title)).toEqual(["Measure rooms"]);
    expect(await blocks(bo)).toEqual([]);
  });

  it("reaches no project the account is not a member of", async () => {
    const { cy, headers, add, blocks } = await homeMove();
    const todo = await add("Book van");
    expect((await cy.call("POST", "/api/v1/blocks", { todoId: todo.id, ...SPAN }, headers)).statusCode).toBe(
      404,
    );
    expect(await blocks(cy)).toEqual([]);
  });

  it("puts your time in shared projects into the calendar feed and the statistics", async () => {
    const { t, bo, space, headers, add } = await homeMove();
    const todo = await add("Book van");
    await bo.call("POST", "/api/v1/blocks", { todoId: todo.id, ...SPAN }, headers);
    await bo.create("/api/v1/blocks", { title: "Gym", ...SPAN });
    t.setNow("2026-11-14T10:00:00.000Z");

    const feed = await bo.call("POST", "/api/v1/calendar-feed");
    const path = new URL(json<{ url: string }>(feed).url).pathname;
    const ics = (await t.app.inject({ method: "GET", url: path })).body;
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).toContain("SUMMARY:Book van");
    expect(ics).toContain(`URL:https://todo.example.com/u/bobo/shared/${space.id}/todos/${todo.id}`);
    expect(ics).toContain(`S${space.id}#${todo.id} in Sloppanizer`);
    expect(ics).toContain(`UID:block-s${space.id}-`);

    const stats = json<WorkStats>(await bo.call("GET", `/api/v1/stats/overview?${WEEK}`));
    expect(stats.totals.workedMinutes).toBe(180);
    expect(stats.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "untitled", minutes: 90, space: null }),
        expect.objectContaining({
          kind: "project",
          minutes: 90,
          space: { id: space.id, name: "Home move", color: space.color },
        }),
      ]),
    );
  });
});
