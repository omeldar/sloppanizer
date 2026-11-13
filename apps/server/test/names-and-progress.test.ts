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

  it("treats topics that differ only in non-ASCII case as one topic", async () => {
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

  it("finds and renames topics without non-ASCII case, and refuses a rename onto one", async () => {
    const t = await makeApp();
    await t.create<Person>("/api/v1/people", { firstName: "A", lastName: "B", topics: ["Ärzte", "Öl"] });
    const found = json<Topic[]>(await t.call("GET", `/api/v1/topics?q=${encodeURIComponent("ÄRZ")}`));
    expect(found.map((x) => x.name)).toEqual(["Ärzte"]);
    // A decomposed "a + combining umlaut" is the same letter.
    const decomposed = json<Topic[]>(
      await t.call("GET", `/api/v1/topics?q=${encodeURIComponent("a\u0308rz")}`),
    );
    expect(decomposed.map((x) => x.name)).toEqual(["Ärzte"]);
    const oil = (await topics(t)).find((x) => x.name === "Öl") as Topic;
    const clash = await t.call("PATCH", `/api/v1/topics/${oil.id}`, { name: "ÄRZTE" });
    expect(clash.statusCode).toBe(409);
    expect((await t.call("PATCH", `/api/v1/topics/${oil.id}`, { name: "öL" })).statusCode).toBe(200);
    expect((await topics(t)).map((x) => x.name)).toEqual(["Ärzte", "öL"]);
    const byTopic = json<Person[]>(
      await t.call("GET", `/api/v1/people?topic=${encodeURIComponent("ärzte")}`),
    );
    expect(byTopic).toHaveLength(1);
  });

  it("keeps person tag and label names unique without non-ASCII case", async () => {
    const t = await makeApp();
    await t.create<PersonTag>("/api/v1/person-tags", { name: "Überlegt" });
    const dupTag = await t.call("POST", "/api/v1/person-tags", { name: "überlegt" });
    expect(dupTag.statusCode).toBe(409);
    const p = await t.create<Person>("/api/v1/people", { firstName: "A", lastName: "B", tags: ["ÜBERLEGT"] });
    expect(p.tags.map((x) => x.name)).toEqual(["Überlegt"]);
    expect(
      json<Person[]>(await t.call("GET", `/api/v1/people?tag=${encodeURIComponent("überlegt")}`)),
    ).toHaveLength(1);

    await t.create("/api/v1/labels", { name: "Ärger" });
    expect((await t.call("POST", "/api/v1/labels", { name: "ärger" })).statusCode).toBe(409);
    const todo = await t.create<Todo>("/api/v1/todos", { title: "T", labels: ["ÄRGER"] });
    expect(todo.labels.map((l) => l.name)).toEqual(["Ärger"]);
  });

  it("counts teams that differ only in non-ASCII case as one team", async () => {
    const t = await makeApp();
    for (const [lastName, team] of [
      ["A", "Ärzteteam"],
      ["B", "ärzteteam"],
      ["C", "ÄRZTETEAM"],
      ["D", "Pflege"],
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- the first stored spelling names the team
      await t.create<Person>("/api/v1/people", { firstName: "X", lastName, team });
    }
    expect(json(await t.call("GET", "/api/v1/teams"))).toEqual([
      { name: "Ärzteteam", peopleCount: 3 },
      { name: "Pflege", peopleCount: 1 },
    ]);
    const team = json<Person[]>(
      await t.call("GET", `/api/v1/people?team=${encodeURIComponent("ärzteTEAM")}`),
    );
    expect(team.map((x) => x.lastName).toSorted()).toEqual(["A", "B", "C"]);
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

describe("todo and note list filter q", () => {
  it("matches titles without case in every script", async () => {
    const t = await makeApp();
    const todo = await t.create<Todo>("/api/v1/todos", { title: "Termin beim Ärztehaus" });
    await t.create<Todo>("/api/v1/todos", { title: "Arzt" });
    const note = await t.create<{ id: number }>("/api/v1/notes", {
      title: "Übergabe Ärztehaus",
      bodyMd: "x",
    });
    await t.create("/api/v1/notes", { title: "Other", bodyMd: "x" });
    const todoIds = async (text: string) =>
      json<{ items: Todo[] }>(await t.call("GET", `/api/v1/todos?q=${encodeURIComponent(text)}`)).items.map(
        (x) => x.id,
      );
    const noteIds = async (text: string) =>
      json<{ items: { id: number }[] }>(
        await t.call("GET", `/api/v1/notes?q=${encodeURIComponent(text)}`),
      ).items.map((x) => x.id);
    expect(await todoIds("ärztehaus")).toEqual([todo.id]);
    expect(await todoIds("ÄRZTEHAUS")).toEqual([todo.id]);
    expect(await noteIds("üBERGABE")).toEqual([note.id]);
    // Still literal: LIKE wildcards in q match only themselves.
    expect(await todoIds("%")).toEqual([]);
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
