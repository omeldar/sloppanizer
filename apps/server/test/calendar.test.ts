import type { Todo } from "@organizer/shared";
import { describe, expect, it } from "vitest";
import { foldLine, icsText } from "../src/services/calendar.ts";
import { json, makeApp, type TestApp } from "./helpers.ts";

const feedPath = (url: string) => new URL(url).pathname;

async function turnOn(t: TestApp): Promise<string> {
  const res = await t.call("POST", "/api/v1/calendar-feed");
  expect(res.statusCode).toBe(201);
  const { url, webcalUrl } = json<{ url: string; webcalUrl: string }>(res);
  expect(webcalUrl).toBe(url.replace(/^https?:/, "webcal:"));
  return feedPath(url);
}

describe("calendar feed", () => {
  it("is off until turned on, then serves the planner as iCalendar", async () => {
    const t = await makeApp();
    expect(json(await t.call("GET", "/api/v1/calendar-feed"))).toMatchObject({ active: false });
    const todo = await t.create<Todo>("/api/v1/todos", { title: "Write, the; guide" });
    await t.create("/api/v1/blocks", {
      todoId: todo.id,
      startAt: "2026-11-12T08:00:00.000Z",
      endAt: "2026-11-12T09:30:00.000Z",
    });
    await t.create("/api/v1/blocks", {
      title: "Gym",
      startAt: "2026-11-13T17:00:00.000Z",
      endAt: "2026-11-13T18:00:00.000Z",
    });
    const path = await turnOn(t);
    expect(json(await t.call("GET", "/api/v1/calendar-feed"))).toMatchObject({ active: true });

    const res = await t.app.inject({ method: "GET", url: path });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/calendar/);
    const ics = res.body;
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("DTSTART:20261112T080000Z\r\nDTEND:20261112T093000Z");
    expect(ics).toContain("SUMMARY:Write\\, the\\; guide");
    expect(ics).toContain("SUMMARY:Gym");
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    // Every line is CRLF terminated and at most 75 octets.
    for (const line of ics.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
  });

  it("has every date of a repeating todo's planned time: moved ones moved, cancelled ones gone", async () => {
    const t = await makeApp();
    const todo = await t.create<Todo>("/api/v1/todos", {
      title: "Team report",
      dueOn: "2026-11-16",
      recurrence: { every: "week", weekdays: ["mon"], until: "2026-12-07" },
    });
    await t.create(`/api/v1/todos/${todo.id}/plan`, {
      startAt: "2026-11-16T08:00:00.000Z",
      endAt: "2026-11-16T09:00:00.000Z",
    });
    const plan = (on: string, body: unknown) => t.call("PATCH", `/api/v1/todos/${todo.id}/plan/${on}`, body);
    await plan("2026-11-23", {
      scope: "this",
      startAt: "2026-11-23T13:00:00.000Z",
      endAt: "2026-11-23T14:00:00.000Z",
    });
    await plan("2026-11-30", { scope: "this", cancelled: true });
    const ics = (await t.app.inject({ method: "GET", url: await turnOn(t) })).body;
    const events = [...ics.matchAll(/UID:(\S+)\r\n(?:.*\r\n)*?DTSTART:(\S+)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(events).toEqual([
      expect.stringMatching(/^plan-\d+-20261116@sloppanizer 20261116T080000Z$/),
      expect.stringMatching(/^plan-\d+-20261123@sloppanizer 20261123T130000Z$/),
      expect.stringMatching(/^plan-\d+-20261207@sloppanizer 20261207T080000Z$/),
    ]);
    expect(ics.match(/SUMMARY:Team report/g)).toHaveLength(3);
  });

  it("stops the old link when the secret is replaced or the feed is turned off", async () => {
    const t = await makeApp();
    const first = await turnOn(t);
    const second = await turnOn(t);
    expect((await t.app.inject({ method: "GET", url: first })).statusCode).toBe(404);
    expect((await t.app.inject({ method: "GET", url: second })).statusCode).toBe(200);
    expect((await t.call("DELETE", "/api/v1/calendar-feed")).statusCode).toBe(204);
    expect((await t.app.inject({ method: "GET", url: second })).statusCode).toBe(404);
  });

  it("shows only its own account's blocks", async () => {
    const t = await makeApp();
    await t.create("/api/v1/blocks", {
      title: "Anna only",
      startAt: "2026-11-12T08:00:00.000Z",
      endAt: "2026-11-12T09:00:00.000Z",
    });
    const bo = await t.asAccount({ username: "bobby" });
    const res = await bo.call("POST", "/api/v1/calendar-feed");
    const ics = (await t.app.inject({ method: "GET", url: feedPath(json<{ url: string }>(res).url) })).body;
    expect(ics).not.toContain("Anna only");
    expect(ics).not.toContain("BEGIN:VEVENT");
  });

  it("is managed by the browser session only and answers 404 to made up links", async () => {
    const t = await makeApp();
    const raw = t.token("script", "write");
    expect((await t.withToken(raw, "POST", "/api/v1/calendar-feed")).statusCode).toBe(403);
    expect(
      (await t.app.inject({ method: "GET", url: `/api/v1/calendar/${"a".repeat(43)}.ics` })).statusCode,
    ).toBe(404);
    expect((await t.app.inject({ method: "GET", url: "/api/v1/calendar/short.ics" })).statusCode).toBe(404);
  });
});

describe("iCalendar text", () => {
  it("escapes text and folds long lines without splitting characters", () => {
    expect(icsText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
    const folded = foldLine(`SUMMARY:${"ä".repeat(60)}`);
    for (const line of folded.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, "")).toBe(`SUMMARY:${"ä".repeat(60)}`);
  });
});
