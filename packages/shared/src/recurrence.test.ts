import { describe, expect, it } from "vitest";
import {
  describeRecurrence,
  DONE_BASIS_MESSAGE,
  nextOccurrence,
  normalizeRecurrence,
  recurrenceProblem,
  RecurrenceRule,
  type RecurrenceRuleInput,
  shiftTodoDates,
} from "./recurrence.ts";

const issues = (value: unknown): string[] => {
  const result = RecurrenceRule.safeParse(value);
  return result.success ? [] : result.error.issues.map((i) => i.message);
};

/** Next date when done on the anchor day and today is the anchor day. */
const next = (rule: RecurrenceRuleInput, anchor: string, today = anchor, doneOn = today) =>
  nextOccurrence(rule, { anchor, doneOn, today });

/**
 * The chain of dates a rule produces when each occurrence is done on its own day. Like the server,
 * the rule is normalized once from the first anchor and stored that way.
 */
function chain(input: RecurrenceRuleInput, anchor: string, count: number): string[] {
  const rule = normalizeRecurrence(input, anchor);
  const out: string[] = [];
  let current = anchor;
  for (let i = 0; i < count; i += 1) {
    const date = next(rule, current);
    if (date === null) break;
    out.push(date);
    current = date;
  }
  return out;
}

describe("RecurrenceRule", () => {
  it("fills defaults and accepts every pattern in its own unit", () => {
    expect(RecurrenceRule.parse({ every: "day" })).toEqual({ every: "day", interval: 1, basis: "schedule" });
    expect(issues({ every: "week", weekdays: ["mon", "thu"] })).toEqual([]);
    expect(issues({ every: "month", monthDay: -1 })).toEqual([]);
    expect(issues({ every: "month", monthWeekday: { nth: 2, weekday: "tue" } })).toEqual([]);
    expect(issues({ every: "year", yearDate: "02-29" })).toEqual([]);
    expect(issues({ every: "day", interval: 3, basis: "done", until: "2026-12-31" })).toEqual([]);
  });

  it("refuses patterns outside their unit, mixed month patterns and bad values", () => {
    expect(issues({ every: "day", weekdays: ["mon"] })).toEqual(["Weekdays only work with a weekly repeat."]);
    expect(issues({ every: "week", monthDay: 3 })[0]).toMatch(/monthly repeat/);
    expect(issues({ every: "year", monthWeekday: { nth: 1, weekday: "mon" } })[0]).toMatch(/monthly/);
    expect(issues({ every: "month", monthDay: 3, monthWeekday: { nth: 1, weekday: "mon" } })).toEqual([
      "Pick either a day of the month or a weekday of the month, not both.",
    ]);
    expect(issues({ every: "month", yearDate: "03-14" })[0]).toMatch(/yearly/);
    expect(issues({ every: "week", weekdays: ["mon", "mon"] })[0]).toMatch(/only once/);
    expect(issues({ every: "week", weekdays: [] })).toHaveLength(1);
    expect(issues({ every: "day", interval: 0 })).toHaveLength(1);
    expect(issues({ every: "day", interval: 100 })).toHaveLength(1);
    expect(issues({ every: "month", monthDay: 0 })).toHaveLength(1);
    expect(issues({ every: "month", monthDay: 32 })).toHaveLength(1);
    expect(issues({ every: "month", monthWeekday: { nth: 5, weekday: "mon" } })).toHaveLength(1);
    expect(issues({ every: "year", yearDate: "02-30" })).toHaveLength(1);
    expect(issues({ every: "year", yearDate: "2-3" })).toHaveLength(1);
    expect(issues({ every: "day", extra: true })).toHaveLength(1);
  });

  it("explains that done-based repeats are plain intervals", () => {
    expect(issues({ every: "week", basis: "done", weekdays: ["mon"] })).toEqual([DONE_BASIS_MESSAGE]);
    expect(issues({ every: "month", basis: "done", monthDay: 3 })).toEqual([DONE_BASIS_MESSAGE]);
    expect(issues({ every: "year", basis: "done", yearDate: "01-01" })).toEqual([DONE_BASIS_MESSAGE]);
  });

  it("flags an end date before the anchor", () => {
    expect(recurrenceProblem({ until: "2026-11-01" }, "2026-11-12")).toBe(
      "The repeat ends (01.11.2026) before the todo's date (12.11.2026).",
    );
    expect(recurrenceProblem({ until: "2026-11-12" }, "2026-11-12")).toBeNull();
    expect(recurrenceProblem({ until: null }, "2026-11-12")).toBeNull();
  });
});

describe("normalizeRecurrence", () => {
  it("fills the pattern from the anchor so dates do not drift", () => {
    expect(normalizeRecurrence({ every: "month" }, "2026-01-31").monthDay).toBe(31);
    expect(normalizeRecurrence({ every: "year" }, "2028-02-29").yearDate).toBe("02-29");
    expect(normalizeRecurrence({ every: "week", interval: 2 }, "2026-11-12").weekdays).toEqual(["thu"]);
    expect(normalizeRecurrence({ every: "week", weekdays: ["fri", "mon"] }, "2026-11-12").weekdays).toEqual([
      "mon",
      "fri",
    ]);
  });

  it("keeps explicit patterns and done-based rules as they are", () => {
    const nth = normalizeRecurrence(
      { every: "month", monthWeekday: { nth: 2, weekday: "tue" } },
      "2026-11-12",
    );
    expect(nth.monthDay).toBeUndefined();
    expect(normalizeRecurrence({ every: "month", basis: "done" }, "2026-01-31")).toEqual({
      every: "month",
      interval: 1,
      basis: "done",
    });
  });
});

describe("nextOccurrence (schedule)", () => {
  it("steps days and intervals", () => {
    expect(next({ every: "day" }, "2026-11-12")).toBe("2026-11-13");
    expect(chain({ every: "day", interval: 3 }, "2026-12-30", 3)).toEqual([
      "2027-01-02",
      "2027-01-05",
      "2027-01-08",
    ]);
  });

  it("walks weekday sets and every second week", () => {
    // 2026-11-12 is a Thursday.
    expect(chain({ every: "week", weekdays: ["mon", "thu"] }, "2026-11-12", 4)).toEqual([
      "2026-11-16",
      "2026-11-19",
      "2026-11-23",
      "2026-11-26",
    ]);
    expect(chain({ every: "week", interval: 2, weekdays: ["mon", "thu"] }, "2026-11-12", 4)).toEqual([
      "2026-11-23",
      "2026-11-26",
      "2026-12-07",
      "2026-12-10",
    ]);
    expect(chain({ every: "week" }, "2026-11-12", 2)).toEqual(["2026-11-19", "2026-11-26"]);
    expect(chain({ every: "week", weekdays: ["mon", "tue", "wed", "thu", "fri"] }, "2026-11-13", 2)).toEqual([
      "2026-11-16",
      "2026-11-17",
    ]);
  });

  it("keeps weekly dates across DST changes and the year end", () => {
    // Europe/Paris leaves summer time on 2026-10-25 and enters it on 2027-03-28 (both Sundays).
    expect(chain({ every: "week", weekdays: ["sun"] }, "2026-10-18", 2)).toEqual([
      "2026-10-25",
      "2026-11-01",
    ]);
    expect(chain({ every: "week", weekdays: ["mon"] }, "2027-03-22", 2)).toEqual([
      "2027-03-29",
      "2027-04-05",
    ]);
    expect(chain({ every: "week", weekdays: ["thu"] }, "2026-12-24", 2)).toEqual([
      "2026-12-31",
      "2027-01-07",
    ]);
  });

  it("keeps monthly day 31 and the last day across February, leap year or not", () => {
    expect(chain({ every: "month" }, "2027-01-31", 4)).toEqual([
      "2027-02-28",
      "2027-03-31",
      "2027-04-30",
      "2027-05-31",
    ]);
    expect(chain({ every: "month", monthDay: 31 }, "2028-01-31", 2)).toEqual(["2028-02-29", "2028-03-31"]);
    expect(chain({ every: "month", monthDay: -1 }, "2027-01-31", 3)).toEqual([
      "2027-02-28",
      "2027-03-31",
      "2027-04-30",
    ]);
    expect(chain({ every: "month", interval: 3, monthDay: 15 }, "2026-11-15", 2)).toEqual([
      "2027-02-15",
      "2027-05-15",
    ]);
  });

  it("finds the nth and the last weekday of a month", () => {
    // 2nd Tuesday: Dec 8 2026, Jan 12 2027, Feb 9 2027.
    expect(chain({ every: "month", monthWeekday: { nth: 2, weekday: "tue" } }, "2026-11-10", 3)).toEqual([
      "2026-12-08",
      "2027-01-12",
      "2027-02-09",
    ]);
    // Last Friday: Nov 27 2026, Dec 25 2026, Jan 29 2027.
    expect(chain({ every: "month", monthWeekday: { nth: -1, weekday: "fri" } }, "2026-11-01", 3)).toEqual([
      "2026-11-27",
      "2026-12-25",
      "2027-01-29",
    ]);
  });

  it("puts a yearly Feb 29 on Feb 28 in other years", () => {
    expect(chain({ every: "year" }, "2028-02-29", 4)).toEqual([
      "2029-02-28",
      "2030-02-28",
      "2031-02-28",
      "2032-02-29",
    ]);
    expect(next({ every: "year", interval: 2, yearDate: "03-14" }, "2026-03-14")).toBe("2028-03-14");
  });

  it("skips missed dates instead of building a backlog", () => {
    // Weekly on Thursday, last due 3 weeks ago, done today (a Monday): the next is this Thursday.
    expect(next({ every: "week" }, "2026-10-22", "2026-11-16")).toBe("2026-11-19");
    // A date that matches today is kept.
    expect(next({ every: "day" }, "2026-11-01", "2026-11-12")).toBe("2026-11-12");
    expect(next({ every: "month", monthDay: 5 }, "2026-01-05", "2026-11-12")).toBe("2026-12-05");
  });

  it("stops after until", () => {
    expect(next({ every: "week", until: "2026-11-18" }, "2026-11-12")).toBeNull();
    expect(next({ every: "week", until: "2026-11-19" }, "2026-11-12")).toBe("2026-11-19");
  });
});

describe("nextOccurrence (done)", () => {
  it("counts the interval from the day it was done", () => {
    expect(next({ every: "day", interval: 3, basis: "done" }, "2026-11-01", "2026-11-12")).toBe("2026-11-15");
    expect(next({ every: "week", interval: 2, basis: "done" }, "2026-11-01", "2026-11-12")).toBe(
      "2026-11-26",
    );
    expect(next({ every: "month", basis: "done" }, "2026-11-01", "2027-01-31")).toBe("2027-02-28");
    expect(next({ every: "year", basis: "done" }, "2026-11-01", "2028-02-29")).toBe("2029-02-28");
    expect(next({ every: "day", basis: "done", until: "2026-11-12" }, "2026-11-01", "2026-11-12")).toBeNull();
  });
});

describe("shiftTodoDates", () => {
  it("moves due and planned date by the same days, anchored on the due date", () => {
    expect(shiftTodoDates({ dueOn: "2026-11-12", plannedOn: "2026-11-10" }, "2026-11-19")).toEqual({
      dueOn: "2026-11-19",
      plannedOn: "2026-11-17",
    });
    expect(shiftTodoDates({ dueOn: null, plannedOn: "2026-11-10" }, "2026-12-01")).toEqual({
      dueOn: null,
      plannedOn: "2026-12-01",
    });
    expect(shiftTodoDates({ dueOn: null, plannedOn: null }, "2026-12-01")).toEqual({
      dueOn: null,
      plannedOn: null,
    });
  });
});

describe("describeRecurrence", () => {
  it("says the rule in plain words", () => {
    expect(describeRecurrence({ every: "day" })).toBe("every day");
    expect(describeRecurrence({ every: "week", weekdays: ["fri", "mon", "tue", "wed", "thu"] })).toBe(
      "every weekday",
    );
    expect(describeRecurrence({ every: "week", interval: 2, weekdays: ["thu", "mon"] })).toBe(
      "every 2 weeks on Mon, Thu",
    );
    expect(describeRecurrence({ every: "week", weekdays: ["mon"] })).toBe("every week on Mon");
    expect(describeRecurrence({ every: "month", monthDay: 15 })).toBe("every month on the 15th");
    expect(describeRecurrence({ every: "month", monthDay: 1 })).toBe("every month on the 1st");
    expect(describeRecurrence({ every: "month", monthDay: 22 })).toBe("every month on the 22nd");
    expect(describeRecurrence({ every: "month", monthDay: 13 })).toBe("every month on the 13th");
    expect(describeRecurrence({ every: "month", monthDay: -1 })).toBe("every month on the last day");
    expect(describeRecurrence({ every: "month", monthWeekday: { nth: 2, weekday: "tue" } })).toBe(
      "every month on the 2nd Tuesday",
    );
    expect(describeRecurrence({ every: "month", monthWeekday: { nth: -1, weekday: "fri" } })).toBe(
      "every month on the last Friday",
    );
    expect(describeRecurrence({ every: "year", yearDate: "03-14" })).toBe("every year on 14.03.");
    expect(describeRecurrence({ every: "day", interval: 3, basis: "done" })).toBe("every 3 days after done");
    expect(describeRecurrence({ every: "week", interval: 2 })).toBe("every 2 weeks");
    expect(describeRecurrence({ every: "day", until: "2026-12-31" })).toBe("every day until 31.12.2026");
  });
});
