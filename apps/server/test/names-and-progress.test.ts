import type { Person, PersonTag, Todo, Topic } from "@organizer/shared";
import { describe, expect, it } from "vitest";
import { json, makeApp, type TestApp } from "./helpers.ts";

const patch = (t: TestApp, id: number, body: unknown) => t.call("PATCH", `/api/v1/todos/${id}`, body);
const getTodo = async (t: TestApp, id: number) => json<Todo>(await t.call("GET", `/api/v1/todos/${id}`));
const topics = async (t: TestApp) => json<Topic[]>(await t.call("GET", "/api/v1/topics"));

describe("topic and tag names", () => {
  it("rejects commas, blank names and over-long names in topics, and creates nothing", async () => {
    const t = await makeApp();
    const created = await Promise.all(
      ["a, b", "   ", "x".repeat(200)].map(
        async (bad) =>
          (await t.call("POST", "/api/v1/people", { firstName: "A", lastName: "B", topics: [bad] }))
            .statusCode,
      ),
    );
    expect(created).toEqual([422, 422, 422]);
    const person = await t.create<Person>("/api/v1/people", { firstName: "A", lastName: "B" });
    const patched = await Promise.all(
      [{ topics: ["a,b"] }, { addTopics: ["a,b"] }, { removeTopics: ["a,b"] }].map(
        async (body) => (await t.call("PATCH", `/api/v1/people/${person.id}`, body)).statusCode,
      ),
    );
    expect(patched).toEqual([422, 422, 422]);
    expect(await topics(t)).toEqual([]);
    expect(json<Person[]>(await t.call("GET", "/api/v1/people"))).toHaveLength(1);
  });

  it("rejects a comma in a renamed topic and in person tag names", async () => {
    const t = await makeApp();
    const p = await t.create<Person>("/api/v1/people", { firstName: "A", lastName: "B", topics: ["VPN"] });
    const [topic] = await topics(t);
    expect((await t.call("PATCH", `/api/v1/topics/${topic?.id}`, { name: "VPN, SAP" })).statusCode).toBe(422);
    expect((await topics(t)).map((x) => x.name)).toEqual(["VPN"]);
    expect((await t.call("POST", "/api/v1/person-tags", { name: "fast, kind" })).statusCode).toBe(422);
    expect((await t.call("GET", `/api/v1/people/${p.id}`)).statusCode).toBe(200);
  });

  // BUG: topics.name, person_tags.name and teams use COLLATE NOCASE / lower(), which only folds ASCII
  // (schema.ts:19, topics.ts:111, person-tags.ts:93). "Ärzte" and "ärzte" become two topics.
  it.fails("treats topics that differ only in non-ASCII case as one topic", async () => {
    const t = await makeApp();
    await t.create<Person>("/api/v1/people", { firstName: "A", lastName: "B", topics: ["Ärzte"] });
    const second = await t.create<Person>("/api/v1/people", {
      firstName: "C",
      lastName: "D",
      topics: ["ärzte", "ÄRZTE"],
    });
    expect(second.topics).toEqual(["Ärzte"]);
    expect(await topics(t)).toMatchObject([{ name: "Ärzte", peopleCount: 2 }]);
  });

  it("lets a topic change only the case of its own name", async () => {
    const t = await makeApp();
    await t.create<Person>("/api/v1/people", { firstName: "A", lastName: "B", topics: ["vpn access"] });
    const [topic] = await topics(t);
    const res = await t.call("PATCH", `/api/v1/topics/${topic?.id}`, { name: "VPN Access" });
    expect(res.statusCode).toBe(200);
    expect(json<Topic>(res).name).toBe("VPN Access");
    expect((await topics(t)).map((x) => x.name)).toEqual(["VPN Access"]);
  });

  it("keeps the person's tags when the person is renamed and counts a tag once per person", async () => {
    const t = await makeApp();
    const tag = await t.create<PersonTag>("/api/v1/person-tags", { name: "Fast" });
    const p = await t.create<Person>("/api/v1/people", {
      firstName: "A",
      lastName: "B",
      tags: ["fast", "FAST", "Fast"],
    });
    expect(p.tags.map((x) => x.name)).toEqual(["Fast"]);
    await t.call("PATCH", `/api/v1/people/${p.id}`, { lastName: "Z" });
    const tags = json<PersonTag[]>(await t.call("GET", "/api/v1/person-tags"));
    expect(tags.find((x) => x.id === tag.id)?.peopleCount).toBe(1);
  });
});

describe("subtask progress", () => {
  it("follows done, reopen and delete of direct children only", async () => {
    const t = await makeApp();
    const parent = await t.create<Todo>("/api/v1/todos", { title: "Parent" });
    const [a, b, c] = json<Todo[]>(
      await t.call("POST", `/api/v1/todos/${parent.id}/subtasks`, { titles: ["A", "B", "C"] }),
    ) as [Todo, Todo, Todo];
    // A grandchild does not count for the parent.
    await t.call("POST", `/api/v1/todos/${a.id}/subtasks`, { titles: ["A1", "A2"] });
    const progress = async () => (await getTodo(t, parent.id)).progress.subtasks;
    expect(await progress()).toEqual({ total: 3, done: 0 });

    await patch(t, a.id, { status: "done" });
    await patch(t, b.id, { status: "done" });
    expect(await progress()).toEqual({ total: 3, done: 2 });
    await patch(t, b.id, { status: "open" });
    expect(await progress()).toEqual({ total: 3, done: 1 });
    await t.call("DELETE", `/api/v1/todos/${a.id}`);
    expect(await progress()).toEqual({ total: 2, done: 0 });

    // Finishing the parent leaves the children alone.
    await patch(t, parent.id, { status: "done" });
    expect((await getTodo(t, c.id)).status).toBe("open");
    expect(await progress()).toEqual({ total: 2, done: 0 });
  });

  it("drops a moved child from the old parent's progress and adds it to the new one", async () => {
    const t = await makeApp();
    const one = await t.create<Todo>("/api/v1/todos", { title: "One" });
    const two = await t.create<Todo>("/api/v1/todos", { title: "Two" });
    const [child] = json<Todo[]>(
      await t.call("POST", `/api/v1/todos/${one.id}/subtasks`, { titles: ["Child"] }),
    ) as [Todo];
    await patch(t, child.id, { status: "done" });
    expect((await patch(t, child.id, { parentId: two.id })).statusCode).toBe(200);
    expect((await getTodo(t, one.id)).progress.subtasks).toEqual({ total: 0, done: 0 });
    expect((await getTodo(t, two.id)).progress.subtasks).toEqual({ total: 1, done: 1 });
    expect((await patch(t, child.id, { parentId: null })).statusCode).toBe(200);
    expect((await getTodo(t, two.id)).progress.subtasks).toEqual({ total: 0, done: 0 });
  });
});
