import { describe, expect, it } from "vitest";
import {
  checkPlan,
  checkSteps,
  checkSummary,
  type PlanContext,
  planPrompt,
  STANDUP_PROMPT_CHARS,
  standupPrompt,
} from "./ai.ts";

const context: PlanContext = {
  day: "2026-11-16",
  dayStart: "09:00",
  dayEnd: "17:00",
  busy: [[12 * 60, 13 * 60]],
  candidates: [
    { id: 1, title: "Renew certs" },
    { id: 2, title: "Write guide" },
    { id: 3, title: "Order disks" },
  ],
  notBefore: null,
};

describe("checkPlan", () => {
  it("keeps blocks inside free working time and drops the rest", () => {
    const blocks = checkPlan(
      {
        note: "",
        blocks: [
          { todoId: 2, start: "13:00", end: "14:30", why: "after lunch" },
          { todoId: 1, start: "09:05", end: "10:00", why: "overdue" },
          { todoId: 9, start: "10:00", end: "11:00", why: "not a candidate" },
          { todoId: 3, start: "11:30", end: "12:30", why: "overlaps lunch" },
          { todoId: 3, start: "16:30", end: "17:30", why: "past the day" },
          { todoId: 2, start: "15:00", end: "16:00", why: "second time" },
          { todoId: 3, start: "7:00", end: "8:00", why: "bad time" },
        ],
      },
      context,
    );
    expect(blocks.map((b) => [b.todoId, b.start, b.end])).toEqual([
      [1, "09:15", "10:00"],
      [2, "13:00", "14:30"],
    ]);
    expect(blocks[0]?.title).toBe("Renew certs");
  });

  it("plans nothing before now on today", () => {
    const blocks = checkPlan(
      { note: "", blocks: [{ todoId: 1, start: "09:00", end: "10:00", why: "" }] },
      { ...context, notBefore: "11:00" },
    );
    expect(blocks).toEqual([]);
  });
});

describe("checkSteps", () => {
  it("cleans list markers, drops duplicates and existing steps", () => {
    expect(
      checkSteps({ note: "", steps: ["1. Buy cables", "- Buy cables", "Mount rack", "  ", "Label ports"] }, [
        "mount rack",
      ]),
    ).toEqual(["Buy cables", "Label ports"]);
  });
});

describe("planPrompt", () => {
  it("lists busy time and ranked candidates", () => {
    const { user } = planPrompt({
      day: "2026-11-16",
      weekday: "Monday",
      dayStart: "09:00",
      dayEnd: "17:00",
      notBefore: null,
      busy: [{ start: "12:00", end: "13:00", title: "Lunch" }],
      candidates: [
        {
          id: 1,
          title: "Renew certs",
          priority: "critical",
          dueOn: "2026-11-13",
          plannedOn: null,
          labels: [],
          reasons: ["overdue 3d"],
          status: "open",
          notes: "",
        },
      ],
    });
    expect(user).toContain("- 12:00-13:00 Lunch");
    expect(user).toContain("- id 1: Renew certs | priority critical | due 2026-11-13 | (overdue 3d)");
  });
});

const item = (i: number) => ({
  kind: "updated" as const,
  title: `Todo ${i} ${"t".repeat(80)}`,
  project: "Lab",
  parent: i === 0 ? "Rack" : null,
  changes: ["edited the description"],
  comment: i === 0 ? "waiting\nfor parts" : null,
});

describe("standup summary", () => {
  it("keeps 1 to 8 clean lines of at most 200 characters", () => {
    const answer = checkSummary({
      lines: [
        "- Done: certs renewed",
        "  ",
        "2. Started the guide",
        "x".repeat(300),
        ...Array(9).fill("more"),
      ],
      note: `  ${"n".repeat(400)} `,
    });
    expect(answer.lines.slice(0, 2)).toEqual(["Done: certs renewed", "Started the guide"]);
    expect(answer.lines[2]).toHaveLength(200);
    expect(answer.lines).toHaveLength(8);
    expect(answer.note).toHaveLength(300);
  });

  it("cuts a long list and says how much was left out", () => {
    const { system, user } = standupPrompt({
      meetingName: "Standup",
      since: "12.11.2026 09:00",
      items: Array.from({ length: 100 }, (_, i) => item(i)),
    });
    expect(system).toMatch(/first person/);
    expect(user).toContain("Meeting: Standup. Things since 12.11.2026 09:00:");
    expect(user).toContain(
      "(part of Rack) [Lab] changes: edited the description last comment: waiting for parts",
    );
    expect(user.length).toBeLessThan(STANDUP_PROMPT_CHARS + 200);
    expect(user).toMatch(/\(\d+ more not shown\.\)$/);
    expect(standupPrompt({ meetingName: "S", since: "x", items: [] }).user).toContain("Nothing new.");
  });
});
