import type { NextUp, Stats, Todo } from "@organizer/shared";
import { describe, expect, it } from "vitest";
import { json, makeApp, type TestApp } from "./helpers.ts";

const add = (t: TestApp, body: Record<string, unknown>) => t.create<Todo>("/api/v1/todos", body);
const ids = (r: NextUp) => r.items.map((i) => i.todo.id);
const next = async (t: TestApp, query = "") => json<NextUp>(await t.call("GET", `/api/v1/next${query}`));

describe("GET /next", () => {
  it("ranks by score, puts blocked todos aside and leaves done ones out", async () => {
    const t = await makeApp({ now: "2026-10-01T08:00:00.000Z" });
    const old = await add(t, { title: "Old, no priority" });
    t.setNow("2026-11-11T08:00:00.000Z");
    const critical = await add(t, { title: "Critical", labels: ["priority::critical"] });
    const overdue = await add(t, { title: "Overdue", labels: ["priority::low"], dueOn: "2026-11-09" });
    const blocked = await add(t, { title: "Blocked", status: "blocked", labels: ["priority::critical"] });
    await add(t, { title: "Done", status: "done", labels: ["priority::critical"] });
    const fresh = await add(t, { title: "Fresh" });

    const res = await next(t);
    expect(res.mode).toBe("smart");
    expect(res.today).toBe("2026-11-11");
    expect(res.generatedAt).toBe("2026-11-11T08:00:00.000Z");
    // Critical 40; overdue 2d 34 + low 4 = 38; old: none 8 + open 41d 16.4 + untouched 41d 13.5 = 37.9; fresh 8.
    expect(res.items.map((i) => i.todo.id)).toEqual([critical.id, overdue.id, old.id, fresh.id]);
    expect(res.items.map((i) => i.score)).toEqual([40, 38, 37.9, 8]);
    expect(res.items[2]?.reasons.map((r) => r.label)).toEqual(["open 41d", "untouched 41d"]);
    expect(res.items[1]?.reasons.map((r) => [r.kind, r.label])).toEqual([
      ["overdue", "overdue 2d"],
      ["priority", "priority::low"],
    ]);
    expect(res.blocked.map((b) => b.id)).toEqual([blocked.id]);
  });

  it("supports the other modes, filters and limit", async () => {
    const t = await makeApp();
    const p = await t.create<{ id: number }>("/api/v1/projects", { name: "P" });
    const a = await add(t, { title: "a", labels: ["priority::low"], dueOn: "2026-11-12" });
    t.advance(1000);
    const b = await add(t, { title: "b", labels: ["priority::high"], projectId: p.id });
    t.advance(1000);
    const c = await add(t, { title: "c", dueOn: "2026-11-30" });
    expect(ids(await next(t, "?mode=oldest"))).toEqual([a.id, b.id, c.id]);
    expect(ids(await next(t, "?mode=priority"))).toEqual([b.id, c.id, a.id]);
    expect(ids(await next(t, "?mode=due"))).toEqual([a.id, c.id, b.id]);
    expect(ids(await next(t, `?projectId=${p.id}`))).toEqual([b.id]);
    expect(ids(await next(t, "?projectId=inbox&mode=oldest"))).toEqual([a.id, c.id]);
    expect(ids(await next(t, "?label=priority::low"))).toEqual([a.id]);
    expect(ids(await next(t, "?mode=oldest&limit=1"))).toEqual([a.id]);
    expect((await t.call("GET", "/api/v1/next?mode=random")).statusCode).toBe(422);
  });

  it("uses today in the configured time zone", async () => {
    // 23:30 UTC is already the next day in Zurich.
    const t = await makeApp({ now: "2026-11-11T23:30:00.000Z", timeZone: "Europe/Zurich" });
    await add(t, { title: "due tomorrow in UTC terms", dueOn: "2026-11-12" });
    const res = await next(t);
    expect(res.today).toBe("2026-11-12");
    expect(res.items[0]?.reasons.map((r) => r.label)).toContain("due today");

    const utc = await makeApp({ now: "2026-11-11T23:30:00.000Z", timeZone: "UTC" });
    await add(utc, { title: "x", dueOn: "2026-11-12" });
    const utcRes = await next(utc);
    expect(utcRes.today).toBe("2026-11-11");
    expect(utcRes.items[0]?.reasons.map((r) => r.label)).toContain("due in 1d");
  });
});

describe("GET /stats", () => {
  it("counts by status, dates in the time zone, inbox and the last export", async () => {
    const t = await makeApp({ now: "2026-11-01T09:00:00.000Z" });
    const p = await t.create<{ id: number }>("/api/v1/projects", { name: "P" });
    const doneOld = await add(t, { title: "done long ago" });
    await t.call("PATCH", `/api/v1/todos/${doneOld.id}`, { status: "done" });
    t.setNow("2026-11-11T09:00:00.000Z");
    await add(t, { title: "overdue", dueOn: "2026-11-10" });
    await add(t, { title: "due today", dueOn: "2026-11-11", status: "in_progress", projectId: p.id });
    await add(t, { title: "planned earlier", plannedOn: "2026-11-09", status: "blocked", projectId: p.id });
    await add(t, { title: "planned later", plannedOn: "2026-11-12" });
    await add(t, { title: "done overdue", dueOn: "2026-11-01", status: "done" });
    t.setNow("2026-11-11T10:00:00.000Z");

    const stats = json<Stats>(await t.call("GET", "/api/v1/stats"));
    expect(stats).toEqual({
      open: 2,
      inProgress: 1,
      blocked: 1,
      doneLast7Days: 1,
      overdue: 1,
      dueToday: 1,
      plannedToday: 1,
      inbox: 2,
      lastExportAt: null,
    });
    await t.call("GET", "/api/v1/export.zip");
    expect(json<Stats>(await t.call("GET", "/api/v1/stats")).lastExportAt).toBe("2026-11-11T10:00:00.000Z");
  });
});
