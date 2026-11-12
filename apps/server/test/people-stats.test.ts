import type { Label, PeopleStats, Person, PersonStatDetail, Project, Todo } from "@organizer/shared";
import { describe, expect, it } from "vitest";
import { median, p90 } from "../src/services/people-stats.ts";
import { DAY, json, makeApp, type TestApp } from "./helpers.ts";

const HOUR = 3_600_000;

/**
 * Anna (Platform, topic dns) asked for 3 todos: one done after 1h, one after 3h, one still open.
 * Bo (Ops) asked for one homelab todo in the project and is contact on one of Anna's.
 * Cy has no todos. One old todo of Anna's was created in October.
 */
async function fixture(t: TestApp) {
  t.setNow("2026-10-05T08:00:00.000Z");
  const anna = await t.create<Person>("/api/v1/people", {
    firstName: "Anna",
    lastName: "Meier",
    team: "Platform",
    topics: ["dns"],
  });
  const bo = await t.create<Person>("/api/v1/people", { firstName: "Bo", lastName: "Li", team: "Ops" });
  await t.create<Person>("/api/v1/people", { firstName: "Cy", lastName: "Zed" });
  const old = await t.create<Todo>("/api/v1/todos", { title: "Old", requestedBy: [{ personId: anna.id }] });
  t.setNow("2026-11-11T10:00:00.000Z");
  const project = await t.create<Project>("/api/v1/projects", { name: "Lab" });
  await t.create<Label>("/api/v1/labels", { name: "homelab" });
  const one = await t.create<Todo>("/api/v1/todos", { title: "One", requestedBy: [{ personId: anna.id }] });
  const two = await t.create<Todo>("/api/v1/todos", {
    title: "Two",
    requestedBy: [{ personId: anna.id }],
    contacts: [{ personId: bo.id }],
  });
  await t.create<Todo>("/api/v1/todos", {
    title: "Three",
    requestedBy: [{ personId: bo.id }],
    labels: ["homelab"],
    projectId: project.id,
  });
  t.advance(HOUR);
  await t.call("PATCH", `/api/v1/todos/${one.id}`, { status: "done" });
  t.advance(2 * HOUR);
  await t.call("PATCH", `/api/v1/todos/${two.id}`, { status: "done" });
  t.advance(DAY);
  await t.create<Todo>("/api/v1/todos", { title: "Four", requestedBy: [{ personId: anna.id }] });
  return { anna, bo, old, project };
}

const stats = async (t: TestApp, query = "") => {
  const res = await t.call("GET", `/api/v1/stats/people${query}`);
  if (res.statusCode !== 200) throw new Error(res.body);
  return res.json() as PeopleStats;
};

describe("median and p90", () => {
  it("use the middle (mean of two) and the nearest rank", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([1, 3])).toBe(2);
    expect(median([1, 2, 10])).toBe(2);
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(9);
    expect(p90([1, 3])).toBe(3);
    expect(p90([])).toBeNull();
  });
});

describe("GET /stats/people", () => {
  it("counts requested todos with speed, oldest open and contact numbers", async () => {
    const t = await makeApp();
    const { anna, bo } = await fixture(t);
    const result = await stats(t);
    expect(result.role).toBe("requester");
    expect(result.items.map((i) => i.person.displayName)).toEqual(["Anna Meier", "Bo Li"]);
    const [a, b] = result.items;
    expect(a).toEqual({
      person: {
        id: anna.id,
        firstName: "Anna",
        lastName: "Meier",
        displayName: "Anna Meier",
        note: "",
        team: "Platform",
        email: "",
      },
      requested: {
        total: 4,
        open: 2,
        done: 2,
        medianDoneMs: 2 * HOUR,
        p90DoneMs: 3 * HOUR,
        // "Old" from 2026-10-05; today is 2026-11-12.
        oldestOpenDays: 38,
        lastAt: "2026-11-12T13:00:00.000Z",
      },
      contact: { total: 0, open: 0, done: 0 },
    });
    expect(b?.person.id).toBe(bo.id);
    expect(b?.contact).toEqual({ total: 1, open: 0, done: 1 });
    expect(result.totals).toEqual({ todos: 5, open: 3, done: 2, medianDoneMs: 2 * HOUR });
  });

  it("filters the period on the local created date and narrows by label and project", async () => {
    const t = await makeApp();
    const { project } = await fixture(t);
    const november = await stats(t, "?from=2026-11-01&to=2026-11-11");
    expect(november.items.map((i) => [i.person.firstName, i.requested.total])).toEqual([
      ["Anna", 2],
      ["Bo", 1],
    ]);
    expect(november).toMatchObject({ from: "2026-11-01", to: "2026-11-11" });
    expect((await stats(t, "?label=homelab")).items.map((i) => i.person.firstName)).toEqual(["Bo"]);
    expect((await stats(t, `?projectId=${project.id}`)).items.map((i) => i.person.firstName)).toEqual(["Bo"]);
    expect((await stats(t, "?projectId=inbox")).items.map((i) => i.person.firstName)).toEqual(["Anna"]);
    expect((await stats(t, "?from=2026-12-01")).items).toEqual([]);
  });

  it("chooses people by topic, tag and team, and lists contacts with role=contact", async () => {
    const t = await makeApp();
    await fixture(t);
    expect((await stats(t, "?topic=DNS")).items.map((i) => i.person.firstName)).toEqual(["Anna"]);
    expect((await stats(t, "?team=ops")).items.map((i) => i.person.firstName)).toEqual(["Bo"]);
    expect((await stats(t, "?tag=nobody")).items).toEqual([]);
    const contacts = await stats(t, "?role=contact");
    expect(contacts.items.map((i) => i.person.firstName)).toEqual(["Bo"]);
    expect(contacts.totals).toEqual({ todos: 1, open: 0, done: 1, medianDoneMs: 3 * HOUR });
  });

  it("sorts by open, done, speed, recent and name, and limits", async () => {
    const t = await makeApp();
    const { bo } = await fixture(t);
    const order = async (sort: string) =>
      (await stats(t, `?sort=${sort}`)).items.map((i) => i.person.firstName);
    expect(await order("open")).toEqual(["Anna", "Bo"]);
    // Bo has no done requested todo: last for speed.
    expect(await order("speed")).toEqual(["Anna", "Bo"]);
    expect(await order("recent")).toEqual(["Anna", "Bo"]);
    expect(await order("name")).toEqual(["Bo", "Anna"]);
    // Bo's todo gets done fast: he is now first by speed.
    const three = json<{ items: Todo[] }>(await t.call("GET", `/api/v1/todos?personId=${bo.id}`)).items[0];
    t.advance(60_000);
    await t.call("PATCH", `/api/v1/todos/${three?.id}`, { status: "done" });
    expect((await stats(t, "?limit=1&sort=done")).items).toHaveLength(1);
    expect((await t.call("GET", "/api/v1/stats/people?sort=fast")).statusCode).toBe(422);
  });
});

describe("GET /stats/people/:id", () => {
  it("gives the person's numbers and 12 months with zeros", async () => {
    const t = await makeApp();
    const { anna, bo } = await fixture(t);
    const detail = json<PersonStatDetail>(await t.call("GET", `/api/v1/stats/people/${anna.id}`));
    expect(detail.stat.requested.total).toBe(4);
    expect(detail.months).toHaveLength(12);
    expect(detail.months[0]?.month).toBe("2025-12");
    expect(detail.months.at(-1)).toEqual({ month: "2026-11", requested: 3, done: 2, contact: 0 });
    expect(detail.months.at(-2)).toEqual({ month: "2026-10", requested: 1, done: 0, contact: 0 });
    expect(detail.months.slice(0, 10).every((m) => m.requested === 0)).toBe(true);
    const boDetail = json<PersonStatDetail>(
      await t.call("GET", `/api/v1/stats/people/${bo.id}?label=homelab`),
    );
    expect(boDetail.stat.contact.total).toBe(0);
    expect(boDetail.stat.requested.total).toBe(1);
    expect((await t.call("GET", "/api/v1/stats/people/999")).statusCode).toBe(404);
    expect((await t.call("GET", `/api/v1/stats/people/${anna.id}?role=contact`)).statusCode).toBe(422);
  });
});
