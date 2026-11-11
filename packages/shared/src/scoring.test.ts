import { describe, expect, it } from "vitest";
import { buildNextUp, rankTodos, type ScorableTodo, scoreTodo } from "./scoring.ts";

const TZ = "Europe/Paris";
const TODAY = "2026-11-11";
// Noon in Paris on TODAY, so "created today" stays today.
const NOW_ISO = "2026-11-11T11:00:00.000Z";

let nextId = 1;
function todo(overrides: Partial<ScorableTodo> & { priority?: string } = {}): ScorableTodo {
  const { priority, ...rest } = overrides;
  return {
    id: nextId++,
    status: "open",
    createdAt: NOW_ISO,
    lastActivityAt: NOW_ISO,
    dueOn: null,
    plannedOn: null,
    labels: priority ? [{ name: `priority::${priority}` }] : [],
    ...rest,
  };
}

const ctx = { today: TODAY, timeZone: TZ };
const reasonOf = (t: ScorableTodo, kind: string) => scoreTodo(t, ctx).reasons.find((r) => r.kind === kind);

describe("priority points", () => {
  it.each([
    ["critical", 40],
    ["high", 25],
    ["medium", 12],
    ["low", 4],
  ])("%s gives %d points and a chip with the label name", (priority, points) => {
    const result = scoreTodo(todo({ priority }), ctx);
    expect(result.score).toBe(points);
    expect(result.reasons).toEqual([{ kind: "priority", label: `priority::${priority}`, points }]);
  });

  it("no priority label gives 8 points but no chip", () => {
    const result = scoreTodo(todo(), ctx);
    expect(result.score).toBe(8);
    expect(result.reasons).toEqual([]);
  });

  it("reads the priority scope case-insensitively and ignores other scopes", () => {
    expect(scoreTodo(todo({ labels: [{ name: "Priority::HIGH" }] }), ctx).score).toBe(25);
    expect(scoreTodo(todo({ labels: [{ name: "team::priority" }, { name: "homelab" }] }), ctx).score).toBe(8);
  });
});

describe("due points", () => {
  it.each([
    ["2026-11-10", 32, "overdue 1d", "overdue"],
    ["2026-11-09", 34, "overdue 2d", "overdue"],
    ["2026-11-01", 50, "overdue 10d", "overdue"],
    ["2026-10-01", 50, "overdue 41d", "overdue"],
    ["2026-11-11", 28, "due today", "due_today"],
    ["2026-11-12", 20, "due in 1d", "due_soon"],
    ["2026-11-14", 20, "due in 3d", "due_soon"],
    ["2026-11-15", 10, "due in 4d", "due_soon"],
    ["2026-11-18", 10, "due in 7d", "due_soon"],
    ["2026-11-19", 4, "due in 8d", "due_soon"],
    ["2026-11-25", 4, "due in 14d", "due_soon"],
  ])("due %s gives %d points (%s)", (dueOn, points, label, kind) => {
    expect(reasonOf(todo({ dueOn }), kind)).toEqual({ kind, label, points });
  });

  it("caps overdue at 50 exactly from 10 days on", () => {
    expect(reasonOf(todo({ dueOn: "2026-11-02" }), "overdue")?.points).toBe(48);
    expect(reasonOf(todo({ dueOn: "2026-11-01" }), "overdue")?.points).toBe(50);
  });

  it("gives nothing for a due date 15 or more days away", () => {
    const result = scoreTodo(todo({ dueOn: "2026-11-26" }), ctx);
    expect(result.score).toBe(8);
    expect(result.reasons).toEqual([]);
  });

  it("counts calendar days across a month end", () => {
    const monthEnd = { today: "2026-11-30", timeZone: TZ };
    const created = "2026-11-30T11:00:00.000Z";
    const t = todo({ dueOn: "2026-12-01", createdAt: created, lastActivityAt: created });
    expect(scoreTodo(t, monthEnd).reasons).toEqual([{ kind: "due_soon", label: "due in 1d", points: 20 }]);
    const overdue = todo({ dueOn: "2026-10-31", createdAt: created, lastActivityAt: created });
    expect(scoreTodo(overdue, monthEnd).reasons[0]).toEqual({
      kind: "overdue",
      label: "overdue 30d",
      points: 50,
    });
  });
});

describe("planned points", () => {
  it("gives 15 for planned today or earlier, nothing for later", () => {
    expect(reasonOf(todo({ plannedOn: TODAY }), "planned")).toEqual({
      kind: "planned",
      label: "planned today",
      points: 15,
    });
    expect(reasonOf(todo({ plannedOn: "2026-11-08" }), "planned")?.label).toBe("planned 3d ago");
    expect(reasonOf(todo({ plannedOn: "2026-11-12" }), "planned")).toBeUndefined();
  });
});

describe("age and idle points", () => {
  it("adds 0.4 per day of age, chip only from 7 days", () => {
    const sixDays = scoreTodo(todo({ createdAt: "2026-11-05T11:00:00.000Z" }), ctx);
    expect(sixDays.score).toBe(8 + 2.4);
    expect(sixDays.reasons).toEqual([]);
    const sevenDays = scoreTodo(todo({ createdAt: "2026-11-04T11:00:00.000Z" }), ctx);
    expect(sevenDays.reasons).toEqual([{ kind: "age", label: "open 7d", points: 2.8 }]);
  });

  it("caps age at 20 points (50 days)", () => {
    const at50 = todo({ createdAt: "2026-09-22T11:00:00.000Z" });
    const at120 = todo({ createdAt: "2026-07-14T11:00:00.000Z" });
    expect(reasonOf(at50, "age")).toEqual({ kind: "age", label: "open 50d", points: 20 });
    expect(reasonOf(at120, "age")?.points).toBe(20);
  });

  it("gives no idle points at exactly 14 untouched days and 0.5 per day after", () => {
    const created = "2026-09-01T11:00:00.000Z";
    const at14 = todo({ createdAt: created, lastActivityAt: "2026-10-28T11:00:00.000Z" });
    const at15 = todo({ createdAt: created, lastActivityAt: "2026-10-27T11:00:00.000Z" });
    expect(reasonOf(at14, "idle")).toBeUndefined();
    expect(reasonOf(at15, "idle")).toEqual({ kind: "idle", label: "untouched 15d", points: 0.5 });
  });

  it("caps idle at 15 points (44 days)", () => {
    const created = "2026-01-01T11:00:00.000Z";
    expect(
      reasonOf(todo({ createdAt: created, lastActivityAt: "2026-09-28T11:00:00.000Z" }), "idle"),
    ).toEqual({
      kind: "idle",
      label: "untouched 44d",
      points: 15,
    });
    expect(reasonOf(todo({ createdAt: created, lastActivityAt: created }), "idle")?.points).toBe(15);
  });

  it("counts local calendar days, so the DST change in Europe/Paris does not shift the boundary", () => {
    // Clocks went back on 2026-10-25. 14 calendar days are 14 days plus 1 hour of real time here.
    const afterFallBack = { today: "2026-11-03", timeZone: TZ };
    const t = todo({ createdAt: "2026-10-01T10:00:00.000Z", lastActivityAt: "2026-10-20T10:00:00.000Z" });
    expect(scoreTodo(t, afterFallBack).reasons.find((r) => r.kind === "idle")).toBeUndefined();

    // Clocks went forward on 2026-03-29. 23:30 UTC on 28 March is already 29 March in Paris.
    const springWeek = { today: "2026-04-05", timeZone: TZ };
    const justAfterMidnight = todo({ createdAt: "2026-03-28T23:30:00.000Z" });
    const justBeforeMidnight = todo({ createdAt: "2026-03-28T22:59:00.000Z" });
    expect(scoreTodo(justAfterMidnight, springWeek).reasons).toEqual([
      { kind: "age", label: "open 7d", points: 2.8 },
    ]);
    expect(scoreTodo(justBeforeMidnight, springWeek).reasons).toEqual([
      { kind: "age", label: "open 8d", points: 3.2 },
    ]);
  });

  it("treats a creation date after today as age 0", () => {
    expect(scoreTodo(todo({ createdAt: "2026-11-20T11:00:00.000Z" }), ctx).score).toBe(8);
  });
});

describe("in progress and totals", () => {
  it("adds 10 for in progress", () => {
    expect(reasonOf(todo({ status: "in_progress" }), "in_progress")).toEqual({
      kind: "in_progress",
      label: "in progress",
      points: 10,
    });
  });

  it("sums every rule and orders chips by points", () => {
    const t = todo({
      priority: "high",
      status: "in_progress",
      dueOn: "2026-11-09",
      plannedOn: "2026-11-10",
      createdAt: "2026-10-01T11:00:00.000Z",
      lastActivityAt: "2026-10-01T11:00:00.000Z",
    });
    const result = scoreTodo(t, ctx);
    // 25 high + 34 overdue 2d + 15 planned + 10 in progress + 16.4 age 41d + 13.5 idle 41d
    expect(result.score).toBe(113.9);
    expect(result.reasons.map((r) => r.kind)).toEqual([
      "overdue",
      "priority",
      "age",
      "planned",
      "idle",
      "in_progress",
    ]);
  });
});

describe("rankTodos", () => {
  const options = { today: TODAY, timeZone: TZ };

  it("leaves out done todos and lists blocked ones apart, oldest first", () => {
    const done = todo({ status: "done" });
    const blockedNew = todo({ status: "blocked", createdAt: "2026-11-10T08:00:00.000Z" });
    const blockedOld = todo({
      status: "blocked",
      createdAt: "2026-11-01T08:00:00.000Z",
      priority: "critical",
    });
    const open = todo();
    const result = rankTodos([done, blockedNew, open, blockedOld], { ...options, mode: "smart" });
    expect(result.items.map((i) => i.todo)).toEqual([open]);
    expect(result.blocked).toEqual([blockedOld, blockedNew]);
  });

  it("smart: score desc, then older first, then lower id", () => {
    const low = todo({ priority: "low" });
    const highNew = todo({ priority: "high", createdAt: "2026-11-11T10:00:00.000Z" });
    const highOld = todo({ priority: "high", createdAt: "2026-11-11T09:00:00.000Z" });
    const result = rankTodos([low, highNew, highOld], { ...options, mode: "smart" });
    expect(result.items.map((i) => i.todo)).toEqual([highOld, highNew, low]);
    expect(result.items[0]?.score).toBe(25);
  });

  it("oldest: createdAt ascending, and still returns score and reasons", () => {
    const a = todo({ createdAt: "2026-11-03T08:00:00.000Z", priority: "critical" });
    const b = todo({ createdAt: "2026-10-01T08:00:00.000Z" });
    const c = todo({ createdAt: "2026-11-10T08:00:00.000Z" });
    const result = rankTodos([a, b, c], { ...options, mode: "oldest" });
    expect(result.items.map((i) => i.todo)).toEqual([b, a, c]);
    expect(result.items[1]?.reasons[0]).toEqual({
      kind: "priority",
      label: "priority::critical",
      points: 40,
    });
  });

  it("priority: critical, high, medium, none, low, then due ascending with nulls last, then oldest", () => {
    const none = todo();
    const low = todo({ priority: "low" });
    const mediumNoDue = todo({ priority: "medium" });
    const mediumDueLate = todo({ priority: "medium", dueOn: "2026-12-01" });
    const mediumDueSoonNew = todo({
      priority: "medium",
      dueOn: "2026-11-20",
      createdAt: "2026-11-10T08:00:00.000Z",
    });
    const mediumDueSoonOld = todo({
      priority: "medium",
      dueOn: "2026-11-20",
      createdAt: "2026-11-01T08:00:00.000Z",
    });
    const high = todo({ priority: "high" });
    const critical = todo({ priority: "critical" });
    const result = rankTodos(
      [none, low, mediumNoDue, mediumDueLate, mediumDueSoonNew, mediumDueSoonOld, high, critical],
      {
        ...options,
        mode: "priority",
      },
    );
    expect(result.items.map((i) => i.todo)).toEqual([
      critical,
      high,
      mediumDueSoonOld,
      mediumDueSoonNew,
      mediumDueLate,
      mediumNoDue,
      none,
      low,
    ]);
  });

  it("due: due ascending with nulls last, then priority, then oldest", () => {
    const noDueCritical = todo({ priority: "critical" });
    const noDueLow = todo({ priority: "low" });
    const dueLater = todo({ dueOn: "2026-11-30" });
    const dueSoonLow = todo({ dueOn: "2026-11-12", priority: "low" });
    const dueSoonNone = todo({ dueOn: "2026-11-12" });
    const overdue = todo({ dueOn: "2026-11-01" });
    const result = rankTodos([noDueLow, noDueCritical, dueLater, dueSoonLow, dueSoonNone, overdue], {
      ...options,
      mode: "due",
    });
    expect(result.items.map((i) => i.todo)).toEqual([
      overdue,
      dueSoonNone,
      dueSoonLow,
      dueLater,
      noDueCritical,
      noDueLow,
    ]);
  });

  it("applies the limit to ranked items only", () => {
    const todos = [todo(), todo(), todo(), todo({ status: "blocked" }), todo({ status: "blocked" })];
    const result = rankTodos(todos, { ...options, mode: "smart", limit: 2 });
    expect(result.items).toHaveLength(2);
    expect(result.blocked).toHaveLength(2);
  });
});

describe("buildNextUp", () => {
  it("derives today from now in the given zone", () => {
    // 23:30 UTC on 11 November is already 12 November in Paris.
    const result = buildNextUp([todo({ dueOn: "2026-11-12" })], {
      mode: "smart",
      now: new Date("2026-11-11T23:30:00.000Z"),
      timeZone: TZ,
    });
    expect(result.today).toBe("2026-11-12");
    expect(result.generatedAt).toBe("2026-11-11T23:30:00.000Z");
    expect(result.mode).toBe("smart");
    expect(result.items[0]?.reasons[0]).toEqual({ kind: "due_today", label: "due today", points: 28 });
  });
});
