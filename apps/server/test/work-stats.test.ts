import type { Project, Todo, WorkStats } from "@organizer/shared";
import { describe, expect, it } from "vitest";
import { json, makeApp, type TestApp } from "./helpers.ts";

// The test clock starts on Wednesday 11.11.2026 at 11:00 in Zurich (10:00 UTC).

const WEEK = "from=2026-11-09&to=2026-11-15";
const stats = async (t: TestApp, query = WEEK) =>
  json<WorkStats>(await t.call("GET", `/api/v1/stats/overview?${query}`));
const block = (t: TestApp, body: Record<string, unknown>) => t.create("/api/v1/blocks", body);

/**
 * Lab: report (for Anna) 2 h on Monday and a weekly todo planned 1 h on Tuesday; Gym 1 h on Tuesday
 * without a todo; an Inbox todo with a block running now (half of it has happened) that is done; a
 * future block; a 30 minute meeting on Monday.
 */
async function week(t: TestApp) {
  const lab = await t.create<Project>("/api/v1/projects", { name: "Lab" });
  const report = await t.create<Todo>("/api/v1/todos", {
    title: "Report",
    projectId: lab.id,
    requestedBy: [{ firstName: "Anna", lastName: "Meier" }],
  });
  await block(t, {
    todoId: report.id,
    startAt: "2026-11-09T08:00:00.000Z",
    endAt: "2026-11-09T10:00:00.000Z",
  });
  await block(t, { title: "Gym", startAt: "2026-11-10T17:00:00.000Z", endAt: "2026-11-10T18:00:00.000Z" });
  const quick = await t.create<Todo>("/api/v1/todos", { title: "Quick fix" });
  await block(t, {
    todoId: quick.id,
    startAt: "2026-11-11T09:30:00.000Z",
    endAt: "2026-11-11T10:30:00.000Z",
  });
  await t.call("PATCH", `/api/v1/todos/${quick.id}`, { status: "done" });
  await block(t, {
    todoId: report.id,
    startAt: "2026-11-12T08:00:00.000Z",
    endAt: "2026-11-12T09:00:00.000Z",
  });
  const weekly = await t.create<Todo>("/api/v1/todos", {
    title: "Weekly check",
    projectId: lab.id,
    dueOn: "2026-11-10",
    recurrence: { every: "week" },
  });
  await t.create(`/api/v1/todos/${weekly.id}/plan`, {
    startAt: "2026-11-10T07:00:00.000Z",
    endAt: "2026-11-10T08:00:00.000Z",
  });
  await t.create("/api/v1/meetings", {
    name: "Planning",
    schedule: { rule: { every: "week" }, startsOn: "2026-11-09", startTime: "10:00", durationMinutes: 30 },
  });
  return { lab, report, quick };
}

describe("GET /stats/overview", () => {
  it("counts planned time that has happened per project, requester, week, day and hour", async () => {
    const t = await makeApp();
    const { lab } = await week(t);
    const s = await stats(t);

    expect(s.totals).toEqual({
      workedMinutes: 270,
      meetingMinutes: 30,
      created: 3,
      done: 1,
      medianDoneMs: 0,
    });
    expect(s.projects.map((g) => [g.kind, g.project?.name ?? null, g.minutes, g.done])).toEqual([
      ["project", "Lab", 180, 0],
      ["untitled", null, 60, 0],
      ["inbox", null, 30, 1],
    ]);
    expect(s.projects[0]?.project?.id).toBe(lab.id);
    expect(s.requesters.map((r) => [r.person.name, r.minutes, r.done])).toEqual([["Anna Meier", 120, 0]]);
    expect(s.otherRequesters).toBeNull();

    expect(s.weeks).toEqual([
      {
        start: "2026-11-09",
        workedMinutes: 270,
        meetingMinutes: 30,
        created: 3,
        done: 1,
        projects: [
          { name: "Lab", minutes: 180 },
          { name: "Own title", minutes: 60 },
          { name: "Inbox", minutes: 30 },
        ],
      },
    ]);
    expect(s.days.map((d) => `${d.date} ${d.workedMinutes} ${d.done}`)).toEqual([
      "2026-11-09 120 0",
      "2026-11-10 120 0",
      "2026-11-11 30 1",
      "2026-11-12 0 0",
      "2026-11-13 0 0",
      "2026-11-14 0 0",
      "2026-11-15 0 0",
    ]);
    // Zurich hours: Monday 09 and 10, Tuesday 08 and 18, Wednesday 10:30 to 11:00.
    const cells = s.hours.flatMap((row, day) =>
      row.flatMap((m, hour) => (m > 0 ? [`${day}:${hour} ${m}`] : [])),
    );
    expect(cells).toEqual(["0:9 60", "0:10 60", "1:8 60", "1:18 60", "2:10 30"]);
    expect(s.doneDurations.find((b) => b.bucket === "day")?.count).toBe(1);
  });

  it("splits weeks on Mondays and keeps days outside the period out", async () => {
    const t = await makeApp();
    await week(t);
    const s = await stats(t, "from=2026-11-10&to=2026-11-17");
    expect(s.weeks.map((w) => [w.start, w.workedMinutes])).toEqual([
      ["2026-11-09", 150],
      ["2026-11-16", 0],
    ]);
    expect(s.days[0]?.date).toBe("2026-11-10");
    expect(s.totals.workedMinutes).toBe(150);
  });

  it("refuses more than a year and shows another account nothing", async () => {
    const t = await makeApp();
    await week(t);
    expect((await t.call("GET", "/api/v1/stats/overview?from=2026-01-01&to=2027-01-02")).statusCode).toBe(
      422,
    );
    const bobby = await t.asAccount({ username: "bobby" });
    const s = json<WorkStats>(await bobby.call("GET", `/api/v1/stats/overview?${WEEK}`));
    expect(s.totals).toEqual({
      workedMinutes: 0,
      meetingMinutes: 0,
      created: 0,
      done: 0,
      medianDoneMs: null,
    });
    expect([s.projects, s.requesters]).toEqual([[], []]);
  });
});
