import type { Person, Todo, TodoPage } from "@organizer/shared";
import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { events } from "../src/db/schema.ts";
import { json, makeApp, type TestApp } from "./helpers.ts";

const createTodo = (t: TestApp, body: Record<string, unknown>) => t.create<Todo>("/api/v1/todos", body);
const patch = (t: TestApp, id: number, body: unknown) => t.call("PATCH", `/api/v1/todos/${id}`, body);
const names = (list: { displayName: string }[]) => list.map((p) => p.displayName);
const peopleEvents = (t: TestApp, todoId: number) =>
  t.deps.db
    .select()
    .from(events)
    .where(and(eq(events.todoId, todoId), eq(events.kind, "people_changed")))
    .orderBy(asc(events.id))
    .all()
    .map((e) => JSON.parse(e.data));

describe("contacts on todos", () => {
  it("creates a todo with contacts by id or name, next to requesters", async () => {
    const t = await makeApp();
    const max = await t.create<Person>("/api/v1/people", {
      firstName: "Max",
      lastName: "Muster",
      team: "Network",
    });
    const todo = await createTodo(t, {
      title: "Open firewall port",
      requestedBy: [{ personId: max.id }],
      contacts: [{ personId: max.id }, { firstName: "Bo", lastName: "Li" }],
    });
    expect(names(todo.requestedBy)).toEqual(["Max Muster"]);
    expect(names(todo.contacts)).toEqual(["Max Muster", "Bo Li"]);
    // Todo payloads carry the brief person only: no topics, tags, notes or counts.
    expect(todo.contacts[0]).toEqual({
      id: max.id,
      firstName: "Max",
      lastName: "Muster",
      displayName: "Max Muster",
      note: "",
      team: "Network",
      email: "",
    });
    const created = t.deps.db.select().from(events).where(eq(events.kind, "created")).get();
    expect(JSON.parse(created?.data ?? "{}").to.contacts).toEqual([
      { id: max.id, name: "Max Muster" },
      { id: todo.contacts[1]?.id, name: "Bo Li" },
    ]);
    expect(json<Todo>(await t.call("GET", `/api/v1/todos/${todo.id}`))).toEqual(todo);
  });

  it("adds, removes and replaces contacts with one event per change and role", async () => {
    const t = await makeApp();
    const todo = await createTodo(t, { title: "x", requestedBy: [{ firstName: "Anna", lastName: "Meier" }] });
    t.advance(60_000);
    const added = json<Todo>(
      await patch(t, todo.id, { addContacts: [{ firstName: "Max", lastName: "Muster" }] }),
    );
    expect(names(added.contacts)).toEqual(["Max Muster"]);
    expect(names(added.requestedBy)).toEqual(["Anna Meier"]);
    expect(added.lastActivityAt).toBe("2026-11-11T10:01:00.000Z");

    // Adding a requester as contact too gives a second link, the requester stays. Order: link time.
    t.advance(60_000);
    const both = json<Todo>(
      await patch(t, todo.id, { addContacts: [{ firstName: "anna", lastName: "MEIER" }] }),
    );
    expect(names(both.contacts)).toEqual(["Max Muster", "Anna Meier"]);
    expect(names(both.requestedBy)).toEqual(["Anna Meier"]);

    const removed = json<Todo>(
      await patch(t, todo.id, { removeContacts: [{ personId: added.contacts[0]?.id }] }),
    );
    expect(names(removed.contacts)).toEqual(["Anna Meier"]);
    const replaced = json<Todo>(await patch(t, todo.id, { contacts: [{ firstName: "Bo", lastName: "Li" }] }));
    expect(names(replaced.contacts)).toEqual(["Bo Li"]);
    expect(names(replaced.requestedBy)).toEqual(["Anna Meier"]);

    const max = { id: added.contacts[0]?.id, name: "Max Muster" };
    const anna = { id: todo.requestedBy[0]?.id, name: "Anna Meier" };
    expect(peopleEvents(t, todo.id)).toEqual([
      { role: "contact", from: [], to: [max] },
      { role: "contact", from: [max], to: [max, anna] },
      { role: "contact", from: [max, anna], to: [anna] },
      { role: "contact", from: [anna], to: [{ id: replaced.contacts[0]?.id, name: "Bo Li" }] },
    ]);

    // Same set again: no event, no change.
    const before = peopleEvents(t, todo.id).length;
    t.advance(60_000);
    const same = json<Todo>(await patch(t, todo.id, { contacts: [{ personId: replaced.contacts[0]?.id }] }));
    expect(same.updatedAt).toBe(replaced.updatedAt);
    expect(peopleEvents(t, todo.id)).toHaveLength(before);
  });

  it("records requester changes with role requester", async () => {
    const t = await makeApp();
    const todo = await createTodo(t, { title: "x" });
    await patch(t, todo.id, { addRequestedBy: [{ firstName: "Anna", lastName: "Meier" }] });
    expect(peopleEvents(t, todo.id)[0]).toMatchObject({ role: "requester", from: [] });
  });

  it("applies the requester rules: ambiguous names 409, unknown ids 422, set plus add 422", async () => {
    const t = await makeApp();
    await t.create("/api/v1/people", { firstName: "Anna", lastName: "Meier", note: "IT" });
    await t.create("/api/v1/people", {
      firstName: "Anna",
      lastName: "Meier",
      note: "HR",
      allowDuplicate: true,
    });
    const ambiguous = await t.call("POST", "/api/v1/todos", {
      title: "x",
      contacts: [{ firstName: "Anna", lastName: "Meier" }],
    });
    expect(ambiguous.statusCode).toBe(409);
    expect(ambiguous.json().error.details.candidates).toHaveLength(2);
    expect(ambiguous.json().error.details.candidates[0]).toHaveProperty("counts");
    expect(json<TodoPage>(await t.call("GET", "/api/v1/todos")).total).toBe(0);

    const todo = await createTodo(t, { title: "x" });
    const unknown = await patch(t, todo.id, { addContacts: [{ personId: 99 }] });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().error.details).toEqual({ unknownPersonIds: [99] });
    expect((await patch(t, todo.id, { contacts: [], addContacts: [{ personId: 1 }] })).statusCode).toBe(422);
    // Removing by a name nobody has creates no one.
    expect(
      (await patch(t, todo.id, { removeContacts: [{ firstName: "Not", lastName: "There" }] })).statusCode,
    ).toBe(200);
    expect(json<Person[]>(await t.call("GET", "/api/v1/people"))).toHaveLength(2);
  });

  it("filters todos by person and role (requester by default)", async () => {
    const t = await makeApp();
    const max = await t.create<Person>("/api/v1/people", { firstName: "Max", lastName: "Muster" });
    const requested = await createTodo(t, { title: "requested", requestedBy: [{ personId: max.id }] });
    const contact = await createTodo(t, { title: "contact", contacts: [{ personId: max.id }] });
    const both = await createTodo(t, {
      title: "both",
      requestedBy: [{ personId: max.id }],
      contacts: [{ personId: max.id }],
    });
    await createTodo(t, { title: "none" });
    const ids = async (query: string) =>
      json<TodoPage>(
        await t.call("GET", `/api/v1/todos?personId=${max.id}${query}&sort=created&order=asc`),
      ).items.map((i) => i.id);
    expect(await ids("")).toEqual([requested.id, both.id]);
    expect(await ids("&personRole=requester")).toEqual([requested.id, both.id]);
    expect(await ids("&personRole=contact")).toEqual([contact.id, both.id]);
    expect(await ids("&personRole=any")).toEqual([requested.id, contact.id, both.id]);
    expect((await t.call("GET", "/api/v1/todos?personRole=boss")).statusCode).toBe(422);
  });

  it("refuses to delete a person linked only as contact", async () => {
    const t = await makeApp();
    const max = await t.create<Person>("/api/v1/people", { firstName: "Max", lastName: "Muster" });
    const todo = await createTodo(t, {
      title: "x",
      requestedBy: [{ personId: max.id }],
      contacts: [{ personId: max.id }],
    });
    const res = await t.call("DELETE", `/api/v1/people/${max.id}`);
    expect(res.statusCode).toBe(409);
    // One todo, even though the person is linked twice.
    expect(res.json().error.details).toEqual({ linkedTodos: 1 });
    await patch(t, todo.id, { requestedBy: [] });
    expect((await t.call("DELETE", `/api/v1/people/${max.id}`)).statusCode).toBe(409);
    await patch(t, todo.id, { contacts: [] });
    expect((await t.call("DELETE", `/api/v1/people/${max.id}`)).statusCode).toBe(204);
  });
});

describe("todo list filters for board and week", () => {
  it("filters by planned range, unplanned and doneAfter in the user's time zone", async () => {
    const t = await makeApp({ now: "2026-11-11T10:00:00.000Z", timeZone: "Europe/Zurich" });
    const mon = await createTodo(t, { title: "mon", plannedOn: "2026-11-09" });
    const sun = await createTodo(t, { title: "sun", plannedOn: "2026-11-15" });
    await createTodo(t, { title: "next week", plannedOn: "2026-11-16" });
    const unplanned = await createTodo(t, { title: "unplanned" });
    const ids = async (query: string) =>
      json<TodoPage>(
        await t.call("GET", `/api/v1/todos?status=all&sort=created&order=asc&${query}`),
      ).items.map((i) => i.id);
    expect(await ids("plannedFrom=2026-11-09&plannedTo=2026-11-15")).toEqual([mon.id, sun.id]);
    expect(await ids("unplanned=true")).toEqual([unplanned.id]);
    expect(await ids("unplanned=false&plannedTo=2026-11-09")).toEqual([mon.id]);
    expect((await t.call("GET", "/api/v1/todos?unplanned=true&plannedFrom=2026-11-09")).statusCode).toBe(422);

    // Done at 23:30 UTC on Nov 10 is Nov 11 00:30 in Zurich: inside doneAfter=2026-11-11.
    t.setNow("2026-11-10T22:59:00.000Z");
    await patch(t, mon.id, { status: "done" });
    t.setNow("2026-11-10T23:30:00.000Z");
    await patch(t, sun.id, { status: "done" });
    const done = await ids("doneAfter=2026-11-11");
    expect(done).toContain(sun.id);
    expect(done).not.toContain(mon.id);
    expect(done).toContain(unplanned.id);
  });
});
