import type { Attachment, Comment, MovedTodo, Space, Todo, TodoPage } from "@organizer/shared";
import { describe, expect, it } from "vitest";
import { json, makeApp } from "./helpers.ts";

// S5#7: a todo moves between your own todos and shared projects (copied there, the original done).

const H = "x-sloppanizer-space";
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]);

async function setup() {
  const t = await makeApp();
  const bo = await t.asAccount({ username: "bobo" });
  const cy = await t.asAccount({ username: "cyra" });
  await t.call("PATCH", "/api/v1/account", { firstName: "Anna", lastName: "Berg" });
  const space = await t.create<Space>("/api/v1/spaces", { name: "Extranet", members: ["bobo"] });
  const headers = { [H]: String(space.id) };
  const [project] = json<{ id: number }[]>(await t.call("GET", "/api/v1/projects", undefined, headers));
  return { t, bo, cy, space, headers, projectId: project?.id as number };
}

describe("moving a todo to a shared project and back (S5#7)", () => {
  it("copies the todo with its thread, checklist, subtasks, labels, people, links and files", async () => {
    const { t, bo, space, headers, projectId } = await setup();
    const upload = await t.app.inject({
      method: "POST",
      url: "/api/v1/attachments?name=plan.png",
      headers: { "content-type": "application/octet-stream", ...t.account.headers() },
      payload: PNG,
    });
    const file = json<Attachment>(upload);
    await t.create("/api/v1/labels", { name: "extranet", color: "#4C9AFF" });
    const other = await t.create<Todo>("/api/v1/todos", { title: "Order servers" });
    const todo = await t.create<Todo>("/api/v1/todos", {
      title: "Launch the extranet",
      descriptionMd: `- [x] Pick a host\n- [ ] DNS\n\n![plan](${file.url})`,
      labels: ["priority::high", "extranet"],
      requestedBy: [{ firstName: "Lu", lastName: "Eng" }, { username: "bobo" }],
      dueOn: "2026-12-01",
      urls: [{ url: "https://example.com/spec", label: "Spec" }],
    });
    await t.call("POST", `/api/v1/todos/${todo.id}/links`, {
      links: [{ kind: "blocks", todoId: other.id }],
    });
    await t.create(`/api/v1/todos/${todo.id}/comments`, { bodyMd: "Host is booked." });
    const [child] = await t.create<Todo[]>(`/api/v1/todos/${todo.id}/subtasks`, {
      titles: ["Write the FAQ"],
    });

    const res = await t.call("POST", `/api/v1/todos/${todo.id}/move`, { spaceId: space.id });
    expect(res.statusCode).toBe(200);
    const moved = json<MovedTodo>(res);
    expect(moved.spaceId).toBe(space.id);
    expect(moved.ref).toBe(`S${space.id}#${moved.todo.id}`);

    // The copy, as a member of the shared project sees it.
    const copy = json<Todo>(await bo.call("GET", `/api/v1/todos/${moved.todo.id}`, undefined, headers));
    expect(copy).toMatchObject({
      title: "Launch the extranet",
      status: "open",
      projectId,
      dueOn: "2026-12-01",
      assignee: { username: "anna" },
      progress: { subtasks: { total: 1, done: 0 }, checklist: { total: 2, done: 1 } },
      urls: [{ url: "https://example.com/spec", label: "Spec" }],
    });
    expect(copy.labels.map((l) => l.name)).toEqual(["priority::high", "extranet"]);
    expect(copy.requestedBy.map((p) => p.displayName).toSorted()).toEqual(["Lu Eng", "bobo"]);
    // The picture is copied into the shared project's files and the link follows it.
    const link = /\]\((\/api\/v1\/attachments\/\d+\/plan\.png)\)/.exec(copy.descriptionMd)?.[1] as string;
    expect(link).toBeTruthy();
    const picture = await bo.call("GET", link, undefined, headers);
    expect(picture.statusCode).toBe(200);
    expect(picture.rawPayload.equals(PNG)).toBe(true);

    const thread = json<Comment[]>(
      await bo.call("GET", `/api/v1/todos/${copy.id}/comments`, undefined, headers),
    );
    expect(thread.map((c) => c.actor)).toEqual(["Anna Berg", "Anna Berg"]);
    expect(thread[0]?.bodyMd).toBe("Host is booked.");
    expect(thread[1]?.bodyMd).toContain(`Moved here from Anna Berg's own todos (#${todo.id})`);
    expect(thread[1]?.bodyMd).toContain(`blocks #${other.id} Order servers`);

    const subtasks = json<TodoPage>(
      await bo.call("GET", `/api/v1/todos?parentId=${copy.id}`, undefined, headers),
    );
    expect(subtasks.items.map((s) => s.title)).toEqual(["Write the FAQ"]);

    // The originals are done and say where the work went; nothing else of yours changed.
    const original = json<Todo>(await t.call("GET", `/api/v1/todos/${todo.id}`));
    expect(original.status).toBe("done");
    expect(json<Todo>(await t.call("GET", `/api/v1/todos/${child?.id}`)).status).toBe("done");
    expect(json<Todo>(await t.call("GET", `/api/v1/todos/${other.id}`)).status).toBe("open");
    const notes = json<Comment[]>(await t.call("GET", `/api/v1/todos/${todo.id}/comments`));
    expect(notes.at(-1)?.actor).toBe("you");
    expect(notes.at(-1)?.bodyMd).toContain(
      `Moved to the shared project Extranet as [S${space.id}#${copy.id}](/u/anna/shared/${space.id}/todos/${copy.id}), with its 1 subtask.`,
    );
  });

  it("moves a shared todo back to your own todos, where your comments are yours again", async () => {
    const { t, bo, space, headers, projectId } = await setup();
    const todo = json<Todo>(
      await t.call("POST", "/api/v1/todos", { title: "Fix login", projectId }, headers),
    );
    await t.call("POST", `/api/v1/todos/${todo.id}/comments`, { bodyMd: "Mine." }, headers);
    await bo.call("POST", `/api/v1/todos/${todo.id}/comments`, { bodyMd: "Bo's." }, headers);
    const own = await t.create<{ id: number }>("/api/v1/projects", { name: "Work" });

    const moved = json<MovedTodo>(
      await t.call("POST", `/api/v1/todos/${todo.id}/move`, { spaceId: null, projectId: own.id }, headers),
    );
    expect(moved).toMatchObject({ spaceId: null, ref: `#${moved.todo.id}` });
    const copy = json<Todo>(await t.call("GET", `/api/v1/todos/${moved.todo.id}`));
    expect(copy).toMatchObject({ title: "Fix login", projectId: own.id, assignee: null });
    const thread = json<Comment[]>(await t.call("GET", `/api/v1/todos/${copy.id}/comments`));
    expect(thread.map((c) => [c.actor, c.bodyMd.split("\n")[0]])).toEqual([
      ["you", "Mine."],
      ["bobo", "Bo's."],
      [
        "you",
        `Moved here from the shared project Extranet (S${space.id}#${todo.id}). Its history and planned time stay with the original there.`,
      ],
    ]);
    // In the shared project the original is done, with a note for the other members.
    const original = json<Todo>(await bo.call("GET", `/api/v1/todos/${todo.id}`, undefined, headers));
    expect(original.status).toBe("done");
    const notes = json<Comment[]>(
      await bo.call("GET", `/api/v1/todos/${todo.id}/comments`, undefined, headers),
    );
    expect(notes.at(-1)).toMatchObject({ actor: "Anna Berg" });
    expect(notes.at(-1)?.bodyMd).toContain("Moved to Anna Berg's own todos as");
  });

  it("does not make a repeat's next todo for the original; the copy repeats", async () => {
    const { t, space, headers } = await setup();
    const todo = await t.create<Todo>("/api/v1/todos", {
      title: "Weekly backup check",
      dueOn: "2026-11-16",
      recurrence: { every: "week", weekdays: ["mon"] },
    });
    const moved = json<MovedTodo>(
      await t.call("POST", `/api/v1/todos/${todo.id}/move`, { spaceId: space.id }),
    );
    expect(moved.todo.recurrence).toEqual(todo.recurrence);
    expect(moved.original.nextOccurrence).toBeNull();
    const mine = json<TodoPage>(await t.call("GET", "/api/v1/todos?status=open"));
    expect(mine.items).toEqual([]);
    const theirs = json<TodoPage>(await t.call("GET", "/api/v1/todos", undefined, headers));
    expect(theirs.items.map((i) => i.title)).toEqual(["Weekly backup check"]);
  });

  it("refuses projects you are not in, the place it already is, read tokens and other people's todos", async () => {
    const { t, cy, space, headers } = await setup();
    const todo = await t.create<Todo>("/api/v1/todos", { title: "Mine" });
    const theirs = await cy.create<Space>("/api/v1/spaces", { name: "Cy's" });

    const notMember = await t.call("POST", `/api/v1/todos/${todo.id}/move`, { spaceId: theirs.id });
    expect(notMember.statusCode).toBe(404);
    expect((await t.call("POST", `/api/v1/todos/${todo.id}/move`, { spaceId: null })).statusCode).toBe(422);
    const read = t.token("reader", "read");
    expect(
      (await t.withToken(read, "POST", `/api/v1/todos/${todo.id}/move`, { spaceId: space.id })).statusCode,
    ).toBe(403);
    // Cy cannot reach Anna's todo, nor act in a project she is not in.
    expect((await cy.call("POST", `/api/v1/todos/${todo.id}/move`, { spaceId: theirs.id })).statusCode).toBe(
      404,
    );
    expect(
      (await cy.call("POST", `/api/v1/todos/${todo.id}/move`, { spaceId: null }, headers)).statusCode,
    ).toBe(404);
    // Nothing moved.
    expect(json<Todo>(await t.call("GET", `/api/v1/todos/${todo.id}`)).status).toBe("open");
    expect(json<TodoPage>(await t.call("GET", "/api/v1/todos", undefined, headers)).items).toEqual([]);
  });

  it("names the token in both histories when an MCP client moves it", async () => {
    const { t, space, headers } = await setup();
    const todo = await t.create<Todo>("/api/v1/todos", { title: "From the assistant" });
    const write = t.token("assistant", "write");
    const res = await t.withToken(write, "POST", `/api/v1/todos/${todo.id}/move`, { spaceId: space.id });
    expect(res.statusCode).toBe(200);
    const moved = json<MovedTodo>(res);
    const thread = json<Comment[]>(
      await t.call("GET", `/api/v1/todos/${moved.todo.id}/comments`, undefined, headers),
    );
    expect(thread.at(-1)?.actor).toBe("Anna Berg via assistant");
    const notes = json<Comment[]>(await t.call("GET", `/api/v1/todos/${todo.id}/comments`));
    expect(notes.at(-1)?.actor).toBe("assistant");
  });
});

describe("members of a shared project", () => {
  it("shows since when each member has access", async () => {
    const { t, space } = await setup();
    const got = json<Space>(await t.call("GET", `/api/v1/spaces/${space.id}`));
    expect(got.members.map((m) => [m.username, m.role, m.addedAt])).toEqual([
      ["anna", "owner", "2026-11-11T10:00:00.000Z"],
      ["bobo", "member", "2026-11-11T10:00:00.000Z"],
    ]);
  });
});
