import type { Person, PersonTag, Team, Todo, Topic } from "@organizer/shared";
import { describe, expect, it } from "vitest";
import { events } from "../src/db/schema.ts";
import { json, makeApp, type TestApp } from "./helpers.ts";

const person = (t: TestApp, body: Record<string, unknown>) => t.create<Person>("/api/v1/people", body);
const tag = (t: TestApp, name: string, color = "#22AA66") =>
  t.create<PersonTag>("/api/v1/person-tags", { name, color });
const getPeople = async (t: TestApp, query = "") =>
  json<Person[]>(await t.call("GET", `/api/v1/people${query}`));
const displayNames = (list: Person[]) => list.map((p) => p.displayName);
const topicNames = async (t: TestApp) =>
  json<Topic[]>(await t.call("GET", "/api/v1/topics")).map((x) => x.name);

describe("person fields, topics and tags", () => {
  it("creates a person with every new field and returns topics, tags and counts", async () => {
    const t = await makeApp();
    await tag(t, "Fast reply");
    const max = await person(t, {
      firstName: "Max",
      lastName: "Muster",
      note: "Platform team, Basel",
      team: "Network team",
      email: "max.muster@example.com",
      notesMd: "Prefers **chat**.",
      topics: ["firewall  rules", "VPN"],
      tags: ["fast reply"],
    });
    expect(max).toMatchObject({
      displayName: "Max Muster",
      note: "Platform team, Basel",
      team: "Network team",
      email: "max.muster@example.com",
      notesMd: "Prefers **chat**.",
      topics: ["firewall rules", "VPN"],
      counts: { requested: 0, requestedOpen: 0, requestedDone: 0, contact: 0, contactOpen: 0 },
    });
    expect(max.tags.map((x) => [x.name, x.peopleCount])).toEqual([["Fast reply", 1]]);
    expect(json<Person>(await t.call("GET", `/api/v1/people/${max.id}`))).toEqual(max);
  });

  it("rejects unknown tags with 422 { unknownTags } and creates nothing", async () => {
    const t = await makeApp();
    const res = await t.call("POST", "/api/v1/people", {
      firstName: "Max",
      lastName: "Muster",
      topics: ["VPN"],
      tags: ["nope", "also nope"],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details).toEqual({ unknownTags: ["nope", "also nope"] });
    expect(await getPeople(t)).toEqual([]);
    expect(await topicNames(t)).toEqual([]);
    const max = await person(t, { firstName: "Max", lastName: "Muster" });
    const patch = await t.call("PATCH", `/api/v1/people/${max.id}`, { addTags: ["nope"], team: "Changed" });
    expect(patch.statusCode).toBe(422);
    expect(json<Person>(await t.call("GET", `/api/v1/people/${max.id}`)).team).toBe("");
  });

  it("finds topics without case, keeps the first spelling and deletes topics no one has", async () => {
    const t = await makeApp();
    const a = await person(t, { firstName: "A", lastName: "One", topics: ["VPN", "SAP access"] });
    const b = await person(t, { firstName: "B", lastName: "Two", topics: ["vpn"] });
    expect(b.topics).toEqual(["VPN"]);
    expect(json<Topic[]>(await t.call("GET", "/api/v1/topics"))).toEqual([
      { id: expect.any(Number), name: "SAP access", peopleCount: 1 },
      { id: expect.any(Number), name: "VPN", peopleCount: 2 },
    ]);

    const removed = json<Person>(
      await t.call("PATCH", `/api/v1/people/${a.id}`, { removeTopics: ["sap ACCESS"] }),
    );
    expect(removed.topics).toEqual(["VPN"]);
    expect(await topicNames(t)).toEqual(["VPN"]);

    await t.call("PATCH", `/api/v1/people/${a.id}`, { topics: [] });
    expect(await topicNames(t)).toEqual(["VPN"]);
    await t.call("DELETE", `/api/v1/people/${b.id}`);
    expect(await topicNames(t)).toEqual([]);
  });

  it("supports full sets and add/remove for topics and tags, 422 when mixed", async () => {
    const t = await makeApp();
    await tag(t, "fast reply");
    await tag(t, "needs a ticket");
    const p = await person(t, {
      firstName: "Max",
      lastName: "Muster",
      topics: ["VPN"],
      tags: ["fast reply"],
    });
    const url = `/api/v1/people/${p.id}`;
    const changed = json<Person>(
      await t.call("PATCH", url, {
        addTopics: ["Firewall"],
        removeTopics: ["VPN"],
        addTags: ["needs a ticket"],
        removeTags: ["fast reply"],
      }),
    );
    expect(changed.topics).toEqual(["Firewall"]);
    expect(changed.tags.map((x) => x.name)).toEqual(["needs a ticket"]);
    const full = json<Person>(await t.call("PATCH", url, { topics: ["b", "a"], tags: [] }));
    expect(full.topics).toEqual(["a", "b"]);
    expect(full.tags).toEqual([]);
    expect((await t.call("PATCH", url, { topics: ["x"], addTopics: ["y"] })).statusCode).toBe(422);
    expect((await t.call("PATCH", url, { tags: [], removeTags: ["y"] })).statusCode).toBe(422);
    expect((await t.call("PATCH", url, { email: "not-an-email" })).statusCode).toBe(422);
  });

  it("does not touch todos when a person changes", async () => {
    const t = await makeApp();
    const p = await person(t, { firstName: "Max", lastName: "Muster" });
    const todo = await t.create<Todo>("/api/v1/todos", { title: "x", contacts: [{ personId: p.id }] });
    const eventCount = t.deps.db.select().from(events).all().length;
    t.advance(3_600_000);
    const renamed = json<Person>(
      await t.call("PATCH", `/api/v1/people/${p.id}`, {
        firstName: "Maximilian",
        team: "Ops",
        topics: ["VPN"],
      }),
    );
    expect(renamed.updatedAt).toBe("2026-11-11T11:00:00.000Z");
    const after = json<Todo>(await t.call("GET", `/api/v1/todos/${todo.id}`));
    expect(after.lastActivityAt).toBe(todo.lastActivityAt);
    expect(after.updatedAt).toBe(todo.updatedAt);
    expect(after.contacts[0]?.displayName).toBe("Maximilian Muster");
    expect(t.deps.db.select().from(events).all()).toHaveLength(eventCount);
    // A PATCH that changes nothing keeps updatedAt.
    t.advance(60_000);
    const same = json<Person>(
      await t.call("PATCH", `/api/v1/people/${p.id}`, { team: "Ops", addTopics: ["vpn"] }),
    );
    expect(same.updatedAt).toBe(renamed.updatedAt);
  });
});

async function directory() {
  const t = await makeApp();
  await tag(t, "fast reply");
  await tag(t, "needs a ticket");
  const hans = await person(t, {
    firstName: "Hans",
    lastName: "Müller",
    team: "Network team",
    email: "hans@example.com",
    topics: ["firewall rules", "VPN"],
    tags: ["fast reply", "needs a ticket"],
  });
  const eva = await person(t, {
    firstName: "Eva",
    lastName: "Keller",
    team: "network TEAM",
    topics: ["VPN"],
    tags: ["fast reply"],
  });
  const otto = await person(t, { firstName: "Otto", lastName: "Arnold", note: "SAP key user" });
  const zoe = await person(t, { firstName: "Zoe", lastName: "Zimmer", team: "Finance" });
  return { t, hans, eva, otto, zoe };
}

describe("GET /people filters, sort and counts", () => {
  it("matches q on names, team, email, note and topics, folding case and umlauts", async () => {
    const { t } = await directory();
    expect(displayNames(await getPeople(t, "?q=muller"))).toEqual(["Hans Müller"]);
    expect(displayNames(await getPeople(t, "?q=M%C3%9CLLER%20hans"))).toEqual(["Hans Müller"]);
    expect(displayNames(await getPeople(t, "?q=hans%20muller"))).toEqual(["Hans Müller"]);
    expect(displayNames(await getPeople(t, "?q=hans%20keller"))).toEqual([]);
    expect(displayNames(await getPeople(t, "?q=network"))).toEqual(["Eva Keller", "Hans Müller"]);
    expect(displayNames(await getPeople(t, "?q=hans%40example"))).toEqual(["Hans Müller"]);
    expect(displayNames(await getPeople(t, "?q=sap"))).toEqual(["Otto Arnold"]);
    expect(displayNames(await getPeople(t, "?q=firewall"))).toEqual(["Hans Müller"]);
  });

  it("filters by topic, team and tag (AND, without case)", async () => {
    const { t } = await directory();
    expect(displayNames(await getPeople(t, "?topic=vpn"))).toEqual(["Eva Keller", "Hans Müller"]);
    expect(displayNames(await getPeople(t, "?topic=vpn,Firewall%20rules"))).toEqual(["Hans Müller"]);
    expect(displayNames(await getPeople(t, "?team=Network%20Team"))).toEqual(["Eva Keller", "Hans Müller"]);
    expect(displayNames(await getPeople(t, "?team=Network"))).toEqual([]);
    expect(displayNames(await getPeople(t, "?tag=Fast%20reply"))).toEqual(["Eva Keller", "Hans Müller"]);
    expect(displayNames(await getPeople(t, "?tag=fast%20reply,needs%20a%20ticket"))).toEqual(["Hans Müller"]);
    expect(displayNames(await getPeople(t, "?tag=unknown"))).toEqual([]);
  });

  it("counts todos per role and status and filters by kind", async () => {
    const { t, hans, eva, otto } = await directory();
    const todo = (body: Record<string, unknown>) => t.create<Todo>("/api/v1/todos", { title: "x", ...body });
    await todo({ requestedBy: [{ personId: otto.id }] });
    await todo({ requestedBy: [{ personId: otto.id }], status: "blocked" });
    await todo({ requestedBy: [{ personId: otto.id }], contacts: [{ personId: hans.id }], status: "done" });
    await todo({ contacts: [{ personId: hans.id }], status: "in_progress" });
    const all = await getPeople(t);
    const counts = (id: number) => all.find((p) => p.id === id)?.counts;
    expect(counts(otto.id)).toEqual({
      requested: 3,
      requestedOpen: 2,
      requestedDone: 1,
      contact: 0,
      contactOpen: 0,
    });
    expect(counts(hans.id)).toEqual({
      requested: 0,
      requestedOpen: 0,
      requestedDone: 0,
      contact: 2,
      contactOpen: 1,
    });
    expect(displayNames(await getPeople(t, "?kind=requester"))).toEqual(["Otto Arnold"]);
    // Contacts: linked as contact, or anyone with a topic (someone to ask).
    expect(displayNames(await getPeople(t, "?kind=contact"))).toEqual(["Eva Keller", "Hans Müller"]);
    expect(counts(eva.id)?.contact).toBe(0);
  });

  it("sorts by name, requested, contact and recent link", async () => {
    const { t, hans, eva, otto, zoe } = await directory();
    expect(displayNames(await getPeople(t))).toEqual([
      "Otto Arnold",
      "Eva Keller",
      "Hans Müller",
      "Zoe Zimmer",
    ]);
    await t.create("/api/v1/todos", {
      title: "a",
      requestedBy: [{ personId: zoe.id }],
      contacts: [{ personId: eva.id }],
    });
    t.advance(60_000);
    await t.create("/api/v1/todos", {
      title: "b",
      requestedBy: [{ personId: zoe.id }, { personId: hans.id }],
      contacts: [{ personId: eva.id }],
    });
    t.advance(60_000);
    await t.create("/api/v1/todos", { title: "c", requestedBy: [{ personId: otto.id }] });
    expect(displayNames(await getPeople(t, "?sort=requested"))).toEqual([
      "Zoe Zimmer",
      "Otto Arnold",
      "Hans Müller",
      "Eva Keller",
    ]);
    expect(displayNames(await getPeople(t, "?sort=contact"))[0]).toBe("Eva Keller");
    expect(displayNames(await getPeople(t, "?sort=recent"))).toEqual([
      "Otto Arnold",
      "Eva Keller",
      "Hans Müller",
      "Zoe Zimmer",
    ]);
    expect((await t.call("GET", "/api/v1/people?sort=age")).statusCode).toBe(422);
  });
});

describe("topics, teams and person tags endpoints", () => {
  it("lists topics by substring, renames with 409 on a taken name and deletes for everyone", async () => {
    const t = await makeApp();
    const p = await person(t, {
      firstName: "Max",
      lastName: "Muster",
      topics: ["Firewall rules", "VPN", "SAP"],
    });
    expect(json<Topic[]>(await t.call("GET", "/api/v1/topics?q=WALL")).map((x) => x.name)).toEqual([
      "Firewall rules",
    ]);
    expect(json<Topic[]>(await t.call("GET", "/api/v1/topics?limit=2")).map((x) => x.name)).toEqual([
      "Firewall rules",
      "SAP",
    ]);
    const topics = json<Topic[]>(await t.call("GET", "/api/v1/topics"));
    const vpn = topics.find((x) => x.name === "VPN") as Topic;
    const sap = topics.find((x) => x.name === "SAP") as Topic;

    const taken = await t.call("PATCH", `/api/v1/topics/${vpn.id}`, { name: "sap" });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.details).toEqual({ existing: { id: sap.id, name: "SAP", peopleCount: 1 } });
    const caseOnly = json<Topic>(
      await t.call("PATCH", `/api/v1/topics/${vpn.id}`, { name: " vpn  access " }),
    );
    expect(caseOnly).toEqual({ id: vpn.id, name: "vpn access", peopleCount: 1 });
    expect(json<Person>(await t.call("GET", `/api/v1/people/${p.id}`)).topics).toContain("vpn access");
    // The renamed topic is searchable on the person right away.
    expect(displayNames(await getPeople(t, "?topic=vpn%20access"))).toEqual(["Max Muster"]);

    expect((await t.call("DELETE", `/api/v1/topics/${sap.id}`)).statusCode).toBe(204);
    expect(json<Person>(await t.call("GET", `/api/v1/people/${p.id}`)).topics).toEqual([
      "Firewall rules",
      "vpn access",
    ]);
    expect((await t.call("DELETE", `/api/v1/topics/${sap.id}`)).statusCode).toBe(404);
    expect((await t.call("PATCH", "/api/v1/topics/999", { name: "x" })).statusCode).toBe(404);
  });

  it("lists distinct teams without case, with the first spelling and counts", async () => {
    const t = await makeApp();
    await person(t, { firstName: "A", lastName: "A", team: "Network team" });
    await person(t, { firstName: "B", lastName: "B", team: "NETWORK TEAM" });
    await person(t, { firstName: "C", lastName: "C", team: "Finance" });
    await person(t, { firstName: "D", lastName: "D" });
    expect(json<Team[]>(await t.call("GET", "/api/v1/teams"))).toEqual([
      { name: "Finance", peopleCount: 1 },
      { name: "Network team", peopleCount: 2 },
    ]);
  });

  it("creates, renames and deletes person tags; names are unique without case", async () => {
    const t = await makeApp();
    const fast = await tag(t, "Fast reply");
    expect(fast).toMatchObject({ name: "Fast reply", color: "#22AA66", description: "", peopleCount: 0 });
    const dupe = await t.call("POST", "/api/v1/person-tags", { name: "FAST REPLY" });
    expect(dupe.statusCode).toBe(409);
    expect(dupe.json().error.details.existing).toEqual(fast);
    const p = await person(t, { firstName: "Max", lastName: "Muster", tags: ["fast reply"] });
    const renamed = json<PersonTag>(
      await t.call("PATCH", `/api/v1/person-tags/${fast.id}`, {
        name: "Quick reply",
        description: "Answers fast",
      }),
    );
    expect(renamed).toMatchObject({ name: "Quick reply", description: "Answers fast", peopleCount: 1 });
    await tag(t, "Other");
    expect((await t.call("PATCH", `/api/v1/person-tags/${fast.id}`, { name: "other" })).statusCode).toBe(409);
    expect(json<PersonTag[]>(await t.call("GET", "/api/v1/person-tags")).map((x) => x.name)).toEqual([
      "Other",
      "Quick reply",
    ]);
    expect((await t.call("DELETE", `/api/v1/person-tags/${fast.id}`)).statusCode).toBe(204);
    expect(json<Person>(await t.call("GET", `/api/v1/people/${p.id}`)).tags).toEqual([]);
    expect((await t.call("DELETE", `/api/v1/person-tags/${fast.id}`)).statusCode).toBe(404);
    expect((await t.call("POST", "/api/v1/person-tags", { name: "a::b" })).statusCode).toBe(422);
  });

  it("lets read tokens list but not change", async () => {
    const t = await makeApp();
    const read = t.token("reader", "read");
    expect((await t.withToken(read, "GET", "/api/v1/person-tags")).statusCode).toBe(200);
    expect((await t.withToken(read, "GET", "/api/v1/topics")).statusCode).toBe(200);
    expect((await t.withToken(read, "GET", "/api/v1/teams")).statusCode).toBe(200);
    expect((await t.withToken(read, "POST", "/api/v1/person-tags", { name: "x" })).statusCode).toBe(403);
    const write = t.token("writer", "write");
    expect((await t.withToken(write, "POST", "/api/v1/person-tags", { name: "x" })).statusCode).toBe(201);
  });
});
