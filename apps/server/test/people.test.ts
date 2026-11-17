import type { Person, Todo } from "@organizer/shared";
import { describe, expect, it } from "vitest";
import { json, makeApp } from "./helpers.ts";

describe("people", () => {
  it("creates, lists, searches, updates and reads people", async () => {
    const t = await makeApp();
    const anna = await t.create<Person>("/api/v1/people", {
      firstName: "Anna",
      lastName: "Meier",
      note: "IT",
    });
    await t.create("/api/v1/people", { firstName: "Bo", lastName: "Andersson" });
    expect(anna).toMatchObject({
      firstName: "Anna",
      lastName: "Meier",
      note: "IT",
      displayName: "Anna Meier",
    });
    const all = json<Person[]>(await t.call("GET", "/api/v1/people"));
    expect(all.map((p) => p.lastName)).toEqual(["Andersson", "Meier"]);
    expect(json<Person[]>(await t.call("GET", "/api/v1/people?q=meier")).map((p) => p.id)).toEqual([anna.id]);
    expect(json<Person[]>(await t.call("GET", "/api/v1/people?q=anna%20m")).map((p) => p.id)).toEqual([
      anna.id,
    ]);
    const updated = json<Person>(await t.call("PATCH", `/api/v1/people/${anna.id}`, { note: "IT, Basel" }));
    expect(updated.note).toBe("IT, Basel");
    expect(json<Person>(await t.call("GET", `/api/v1/people/${anna.id}`)).note).toBe("IT, Basel");
    expect((await t.call("GET", "/api/v1/people/99")).statusCode).toBe(404);
  });

  it("saves languages as a set of known codes, empty when not given", async () => {
    const t = await makeApp();
    const none = await t.create<Person>("/api/v1/people", { firstName: "No", lastName: "Language" });
    expect(none.languages).toEqual([]);
    const anna = await t.create<Person>("/api/v1/people", {
      firstName: "Anna",
      lastName: "Meier",
      languages: ["en", "de"],
    });
    expect(anna.languages).toEqual(["de", "en"]);
    const stored = () => t.deps.db.$client.prepare("SELECT languages FROM people WHERE id = ?").get(anna.id);
    expect(stored()).toEqual({ languages: "de,en" });

    const patch = (body: unknown) => t.call("PATCH", `/api/v1/people/${anna.id}`, body);
    expect(json<Person>(await patch({ languages: ["en"] })).languages).toEqual(["en"]);
    expect(json<Person>(await t.call("GET", `/api/v1/people/${anna.id}`)).languages).toEqual(["en"]);
    // Other edits leave the languages alone.
    expect(json<Person>(await patch({ team: "Network" })).languages).toEqual(["en"]);
    expect(json<Person>(await patch({ languages: [] })).languages).toEqual([]);
    expect(stored()).toEqual({ languages: "" });

    const bad = [["fr"], ["German"], ["DE"], ["de", "en", "de"], "de", null];
    const refused = await Promise.all(
      bad.flatMap((languages) => [
        patch({ languages }),
        t.call("POST", "/api/v1/people", { firstName: "X", lastName: "Y", languages }),
      ]),
    );
    expect(refused.map((r) => [r.statusCode, r.json().error.code])).toEqual(
      refused.map(() => [422, "validation_failed"]),
    );
    expect(stored()).toEqual({ languages: "" });
    expect(json<Person[]>(await t.call("GET", "/api/v1/people")).map((p) => p.lastName)).toEqual([
      "Language",
      "Meier",
    ]);
  });

  it("leaves out language codes it does not know when reading", async () => {
    const t = await makeApp();
    const anna = await t.create<Person>("/api/v1/people", { firstName: "Anna", lastName: "Meier" });
    t.deps.db.$client.prepare("UPDATE people SET languages = 'fr,en' WHERE id = ?").run(anna.id);
    expect(json<Person>(await t.call("GET", `/api/v1/people/${anna.id}`)).languages).toEqual(["en"]);
  });

  it("answers 409 with the existing person for a namesake, unless allowDuplicate", async () => {
    const t = await makeApp();
    const anna = await t.create<Person>("/api/v1/people", { firstName: "Anna", lastName: "Meier" });
    const dupe = await t.call("POST", "/api/v1/people", { firstName: "anna", lastName: "MEIER" });
    expect(dupe.statusCode).toBe(409);
    expect(dupe.json().error.code).toBe("conflict");
    expect(dupe.json().error.details.existing).toEqual(anna);
    const second = await t.call("POST", "/api/v1/people", {
      firstName: "Anna",
      lastName: "Meier",
      note: "Finance",
      allowDuplicate: true,
    });
    expect(second.statusCode).toBe(201);
  });

  it("finds a requester by name case-insensitively (also non-ASCII) or creates one", async () => {
    const t = await makeApp();
    const omer = await t.create<Person>("/api/v1/people", { firstName: "Ömer", lastName: "Çelik" });
    const todo = await t.create<Todo>("/api/v1/todos", {
      title: "x",
      requestedBy: [
        { firstName: "ömer", lastName: "çELİK".replace("İ", "I") },
        { firstName: "New", lastName: "Person" },
      ],
    });
    expect(todo.requestedBy[0]?.id).toBe(omer.id);
    expect(todo.requestedBy[1]?.displayName).toBe("New Person");
    expect(json<Person[]>(await t.call("GET", "/api/v1/people"))).toHaveLength(2);
    const again = await t.create<Todo>("/api/v1/todos", {
      title: "y",
      requestedBy: [{ firstName: "new", lastName: "person" }],
    });
    expect(again.requestedBy[0]?.id).toBe(todo.requestedBy[1]?.id);
  });

  it("answers 409 'ambiguous person, use personId' when several namesakes exist", async () => {
    const t = await makeApp();
    const a = await t.create<Person>("/api/v1/people", { firstName: "Anna", lastName: "Meier", note: "IT" });
    await t.create("/api/v1/people", {
      firstName: "Anna",
      lastName: "Meier",
      note: "HR",
      allowDuplicate: true,
    });
    const res = await t.call("POST", "/api/v1/todos", {
      title: "x",
      requestedBy: [{ firstName: "Anna", lastName: "Meier" }],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain("ambiguous person, use personId");
    expect(res.json().error.details.candidates).toHaveLength(2);
    expect(json<{ items: Todo[] }>(await t.call("GET", "/api/v1/todos")).items).toHaveLength(0);
    const ok = await t.create<Todo>("/api/v1/todos", { title: "x", requestedBy: [{ personId: a.id }] });
    expect(ok.requestedBy.map((p) => p.note)).toEqual(["IT"]);
    expect(
      (await t.call("POST", "/api/v1/todos", { title: "x", requestedBy: [{ personId: 99 }] })).statusCode,
    ).toBe(422);
  });

  it("adds and removes requesters by id or name", async () => {
    const t = await makeApp();
    const todo = await t.create<Todo>("/api/v1/todos", {
      title: "x",
      requestedBy: [{ firstName: "Anna", lastName: "Meier" }],
    });
    const added = json<Todo>(
      await t.call("PATCH", `/api/v1/todos/${todo.id}`, {
        addRequestedBy: [{ firstName: "Bo", lastName: "Li" }],
      }),
    );
    expect(added.requestedBy.map((p) => p.displayName)).toEqual(["Anna Meier", "Bo Li"]);
    const removed = json<Todo>(
      await t.call("PATCH", `/api/v1/todos/${todo.id}`, {
        removeRequestedBy: [{ firstName: "anna", lastName: "meier" }],
      }),
    );
    expect(removed.requestedBy.map((p) => p.displayName)).toEqual(["Bo Li"]);
    const unknownRemove = await t.call("PATCH", `/api/v1/todos/${todo.id}`, {
      removeRequestedBy: [{ firstName: "Not", lastName: "There" }],
    });
    expect(unknownRemove.statusCode).toBe(200);
    expect(json<{ id: number }[]>(await t.call("GET", "/api/v1/people")).length).toBe(2);
  });

  it("refuses to delete a person who is still linked (409 with the count)", async () => {
    const t = await makeApp();
    const anna = await t.create<Person>("/api/v1/people", { firstName: "Anna", lastName: "Meier" });
    const a = await t.create<Todo>("/api/v1/todos", { title: "a", requestedBy: [{ personId: anna.id }] });
    await t.create<Todo>("/api/v1/todos", { title: "b", requestedBy: [{ personId: anna.id }] });
    const res = await t.call("DELETE", `/api/v1/people/${anna.id}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details).toEqual({ linkedTodos: 2 });
    expect(res.json().error.message).toContain("2 todos");
    await t.call("DELETE", `/api/v1/todos/${a.id}`);
    await t.call("POST", "/api/v1/todos/bulk", { ids: [2], patch: { status: "done" } });
    await t.call("PATCH", "/api/v1/todos/2", { requestedBy: [] });
    expect((await t.call("DELETE", `/api/v1/people/${anna.id}`)).statusCode).toBe(204);
    expect((await t.call("DELETE", `/api/v1/people/${anna.id}`)).statusCode).toBe(404);
  });
});
