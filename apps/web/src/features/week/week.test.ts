import { describe, expect, it } from "vitest";
import { makeTodo } from "../../test/render.tsx";
import { weekLists } from "./WeekPage.tsx";
import { daysOfWeek, shiftWeek, weekPlace, weekStart } from "./week.ts";

const WEEK = daysOfWeek("2026-11-12");

describe("week date math", () => {
  it("starts the week on Monday and lists seven days", () => {
    expect(WEEK).toEqual([
      "2026-11-09",
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
      "2026-11-13",
      "2026-11-14",
      "2026-11-15",
    ]);
  });

  it("normalises any day in the URL to its Monday, and falls back to this week", () => {
    expect(weekStart("2026-11-15", "2026-01-01")).toBe("2026-11-09");
    expect(weekStart(undefined, "2026-11-12")).toBe("2026-11-09");
    expect(weekStart("not-a-date", "2026-11-12")).toBe("2026-11-09");
    expect(weekStart("2026-02-30", "2026-11-12")).toBe("2026-11-09");
  });

  it("moves across the year end and the clock change weeks", () => {
    expect(shiftWeek("2026-12-28", 1)).toBe("2027-01-04");
    expect(shiftWeek("2027-01-04", -1)).toBe("2026-12-28");
    expect(daysOfWeek("2026-10-25")[0]).toBe("2026-10-19");
    expect(daysOfWeek("2026-03-29")).toHaveLength(7);
  });
});

describe("where a todo shows", () => {
  it("puts planned todos on their day, with every status", () => {
    expect(weekPlace({ status: "done", plannedOn: "2026-11-10" }, WEEK)).toEqual({
      kind: "day",
      date: "2026-11-10",
    });
  });

  it("carries active todos planned before the week, but not done ones", () => {
    expect(weekPlace({ status: "blocked", plannedOn: "2026-11-02" }, WEEK)).toEqual({ kind: "carried" });
    expect(weekPlace({ status: "done", plannedOn: "2026-11-02" }, WEEK)).toBeNull();
  });

  it("lists active todos without a day as unplanned and hides later weeks", () => {
    expect(weekPlace({ status: "open", plannedOn: null }, WEEK)).toEqual({ kind: "unplanned" });
    expect(weekPlace({ status: "open", plannedOn: "2026-11-16" }, WEEK)).toBeNull();
  });

  it("applies a move that is not saved yet and lists a todo only once", () => {
    const a = makeTodo({ id: 1, plannedOn: null });
    const b = makeTodo({ id: 2, plannedOn: "2026-11-03" });
    const lists = weekLists(
      [a, b, a],
      WEEK,
      new Map([
        [1, "2026-11-11"],
        [2, null],
      ]),
    );
    expect(lists.days.get("2026-11-11")?.map((t) => t.id)).toEqual([1]);
    expect(lists.unplanned.map((t) => t.id)).toEqual([2]);
    expect(lists.carried).toEqual([]);
  });
});
