import type { WorkStats } from "@organizer/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordedCall } from "../../test/render.tsx";
import { renderAppAt } from "../../test/renderApp.tsx";

await import("./StatsPage.tsx");

const LAZY_PAGE = { timeout: 5000 };
const hours = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
hours[1]![14] = 90;

const stats: WorkStats = {
  from: "2026-10-22",
  to: "2026-11-18",
  totals: { workedMinutes: 270, meetingMinutes: 30, created: 3, done: 2, medianDoneMs: 2 * 86_400_000 },
  projects: [
    {
      kind: "project",
      project: { id: 1, slug: "lab", name: "Lab", color: "#4c9aff" },
      space: null,
      minutes: 180,
      done: 1,
    },
    { kind: "untitled", project: null, space: null, minutes: 60, done: 0 },
    { kind: "inbox", project: null, space: null, minutes: 30, done: 1 },
  ],
  requesters: [{ person: { id: 9, name: "Anna Meier" }, minutes: 120, done: 1 }],
  otherRequesters: null,
  meetingPeople: [{ person: { id: 9, name: "Anna Meier" }, minutes: 30, dates: 1 }],
  meetingMinutesWithoutPeople: 0,
  weeks: [
    { start: "2026-11-09", workedMinutes: 120, meetingMinutes: 30, created: 1, done: 0, projects: [] },
    {
      start: "2026-11-16",
      workedMinutes: 150,
      meetingMinutes: 0,
      created: 2,
      done: 2,
      projects: [{ name: "Lab", minutes: 150 }],
    },
  ],
  days: [
    { date: "2026-11-17", workedMinutes: 90, done: 0 },
    { date: "2026-11-18", workedMinutes: 60, done: 2 },
  ],
  hours,
  doneDurations: [
    { bucket: "day", count: 1 },
    { bucket: "3days", count: 1 },
    { bucket: "week", count: 0 },
    { bucket: "2weeks", count: 0 },
    { bucket: "4weeks", count: 0 },
    { bucket: "longer", count: 0 },
  ],
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-18T10:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderStats(path = "/stats") {
  return renderAppAt(path, (call: RecordedCall) => {
    if (call.path.split("?")[0] === "/api/v1/stats/overview") return { body: stats };
    return { status: 404, body: { error: { code: "not_found", message: "Not here." } } };
  });
}

const statsQueries = (calls: RecordedCall[]) =>
  calls.filter((c) => c.path.startsWith("/api/v1/stats/overview")).map((c) => c.path.split("?")[1]);

describe("statistics page", () => {
  it("shows the totals and names every bar with its hours and done todos", async () => {
    const { calls } = renderStats();
    expect(await screen.findByText("4.5 h", {}, LAZY_PAGE)).toBeTruthy();
    expect(statsQueries(calls)).toEqual(["from=2026-10-22&to=2026-11-18"]);
    expect(screen.getByText("2d")).toBeTruthy();

    const projects = screen.getByRole("region", { name: "Worked per project" });
    const rows = within(projects).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      "Lab3 h · 1 done",
      "Own title (no todo)1 h · 0 done",
      "Inbox0.5 h · 1 done",
    ]);
    expect(within(projects).getByRole("link", { name: "Lab" }).getAttribute("href")).toBe("/projects/lab");
    const people = screen.getByRole("region", { name: "Worked for whom" });
    expect(within(people).getByRole("link", { name: "Anna Meier" }).getAttribute("href")).toBe("/people/9");
    expect(screen.getByText("Busiest: Tue, 1.5 h on an average day")).toBeTruthy();
    expect(screen.getByText("1 more created than done: the backlog grows")).toBeTruthy();
  });

  it("lists your time in a shared project as its own group, without a link to an own project (S5#13)", async () => {
    renderAppAt("/stats", (call: RecordedCall) => {
      if (call.path.split("?")[0] !== "/api/v1/stats/overview")
        return { status: 404, body: { error: { code: "not_found", message: "Not here." } } };
      const space = { id: 7, name: "Home move", color: "#4C9AFF" };
      const project = { id: 1, slug: "home-move", name: "Home move", color: "#4C9AFF" };
      return {
        body: { ...stats, projects: [{ kind: "project", project, space, minutes: 90, done: 0 }] },
      };
    });
    await screen.findByText("4.5 h", {}, LAZY_PAGE);
    const projects = screen.getByRole("region", { name: "Worked per project" });
    expect(
      within(projects)
        .getAllByRole("listitem")
        .map((r) => r.textContent),
    ).toEqual(["Home move (shared)1.5 h · 0 done"]);
    expect(within(projects).queryByRole("link")).toBeNull();
  });

  it("shows the time in meetings per person, linking to each person (S5#5)", async () => {
    renderStats();
    const card = await screen.findByRole("region", { name: "In meetings with whom" }, LAZY_PAGE);
    expect(
      within(card)
        .getAllByRole("listitem")
        .map((r) => r.textContent),
    ).toEqual(["Anna Meier0.5 h · 1 meeting"]);
    expect(within(card).getByRole("link", { name: "Anna Meier" }).getAttribute("href")).toBe("/people/9");
  });

  it("shows every chart's numbers as a table too", async () => {
    renderStats();
    const weeks = await screen.findByRole("region", { name: "Focus and meetings per week" }, LAZY_PAGE);
    fireEvent.click(within(weeks).getByRole("button", { name: "Table" }));
    const table = within(weeks).getByRole("table");
    expect(
      within(table)
        .getAllByRole("row")
        .map((r) => r.textContent),
    ).toEqual(["Week ofWorked hMeetings hTop projects", "09.11.202620.5", "16.11.20262.50Lab 2.5 h"]);
    fireEvent.click(within(weeks).getByRole("button", { name: "Chart" }));
    expect(within(weeks).queryByRole("table")).toBeNull();
  });

  it("shows worked time per weekday as one day's average, never more than a day holds (S5#4)", async () => {
    renderStats();
    const card = await screen.findByRole("region", { name: "When you work" }, LAZY_PAGE);
    fireEvent.click(within(card).getByRole("button", { name: "Table" }));
    const rows = within(within(card).getByRole("table"))
      .getAllByRole("row")
      .map((r) => r.textContent);
    expect(rows[0]).toBe("DayDaysWorked hAverage h");
    expect(rows[2]).toBe("Tue11.51.5");
    expect(rows[3]).toBe("Wed111");
    expect(rows).toHaveLength(8);
  });

  it("asks for the period picked above the charts", async () => {
    const { calls } = renderStats();
    fireEvent.click(await screen.findByRole("button", { name: "This year" }, LAZY_PAGE));
    await waitFor(() => expect(statsQueries(calls)).toContain("from=2026-01-01&to=2026-11-18"));
    expect(screen.getByRole("button", { name: "This year" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("reads a custom range from the address", async () => {
    const { calls } = renderStats("/stats?from=2026-11-01&to=2026-11-07");
    await screen.findByText("4.5 h", {}, LAZY_PAGE);
    expect(statsQueries(calls)).toEqual(["from=2026-11-01&to=2026-11-07"]);
    expect(screen.queryAllByRole("button", { pressed: true })).toHaveLength(0);
  });
});
