import { describe, expect, it } from "vitest";
import {
  checkRule,
  draftFrom,
  parseYearDate,
  presets,
  ruleFrom,
  sameRule,
  YEAR_DATE_PROBLEM,
} from "./repeat.ts";

// 2026-11-12 is a Thursday.
const ANCHOR = "2026-11-12";

describe("repeat presets", () => {
  it("words the presets from the todo's date", () => {
    expect(presets(ANCHOR).map((p) => p.label)).toEqual([
      "Every day",
      "Every weekday",
      "Every week on Thu",
      "Every month on the 12th",
      "Every year on 12.11.",
    ]);
  });

  it("treats a rule and its filled-in form as the same", () => {
    expect(sameRule({ every: "week" }, { every: "week", weekdays: ["thu"], interval: 1 }, ANCHOR)).toBe(true);
    expect(
      sameRule(
        { every: "week", weekdays: ["fri", "mon"] },
        { every: "week", weekdays: ["mon", "fri"] },
        ANCHOR,
      ),
    ).toBe(true);
    expect(sameRule({ every: "week" }, { every: "week", interval: 2 }, ANCHOR)).toBe(false);
  });
});

describe("checkRule", () => {
  it("previews the next date and the rule in words", () => {
    const check = checkRule({ every: "week", weekdays: ["mon", "thu"] }, ANCHOR, ANCHOR);
    expect(check).toMatchObject({ ok: true, text: "every week on Mon, Thu", next: "2026-11-16" });
  });

  it("gives the server's plain message for patterns counted from done", () => {
    const check = checkRule({ every: "week", weekdays: ["mon"], basis: "done" }, ANCHOR, ANCHOR);
    expect(check).toEqual({
      ok: false,
      problem: "Repeats counted from the done date use a plain interval, like every 3 days.",
    });
  });

  it("refuses an end before the todo's date and says there is no next one after the end", () => {
    expect(checkRule({ every: "day", until: "2026-11-01" }, ANCHOR, ANCHOR).ok).toBe(false);
    expect(checkRule({ every: "month", until: "2026-11-20" }, ANCHOR, ANCHOR)).toMatchObject({
      ok: true,
      next: null,
    });
  });
});

describe("custom form draft", () => {
  it("round-trips a monthly nth weekday rule", () => {
    const draft = draftFrom(
      { every: "month", interval: 2, basis: "schedule", monthWeekday: { nth: -1, weekday: "fri" } },
      ANCHOR,
    );
    expect(draft.monthMode).toBe("weekday");
    expect(ruleFrom(draft)).toEqual({
      every: "month",
      interval: 2,
      basis: "schedule",
      monthWeekday: { nth: -1, weekday: "fri" },
    });
  });

  it("shows the date in the year as dd.MM. and turns it back into the rule's MM-DD", () => {
    const draft = draftFrom({ every: "year", interval: 1, basis: "schedule", yearDate: "03-04" }, ANCHOR);
    expect(draft.yearDate).toBe("04.03.");
    expect(ruleFrom(draft)).toEqual({ every: "year", interval: 1, basis: "schedule", yearDate: "03-04" });
    expect(ruleFrom({ ...draft, yearDate: "29.2" })).toMatchObject({ yearDate: "02-29" });
  });

  it("explains a date in the year that does not exist in the form's own words", () => {
    const draft = { ...draftFrom(null, ANCHOR), every: "year" as const, yearDate: "31.02." };
    expect(checkRule(ruleFrom(draft), ANCHOR, ANCHOR)).toEqual({ ok: false, problem: YEAR_DATE_PROBLEM });
  });

  it("drops calendar patterns when counting from done", () => {
    const draft = { ...draftFrom(null, ANCHOR), every: "day" as const, interval: 3, basis: "done" as const };
    expect(ruleFrom(draft)).toEqual({ every: "day", interval: 3, basis: "done" });
  });
});

describe("parseYearDate", () => {
  it("reads day and month with or without padding and the last dot", () => {
    expect(parseYearDate("14.03.")).toBe("03-14");
    expect(parseYearDate("4.3")).toBe("03-04");
    expect(parseYearDate(" 01.01. ")).toBe("01-01");
    expect(parseYearDate("29.02.")).toBe("02-29");
  });

  it("refuses days that do not exist and other shapes", () => {
    expect(parseYearDate("31.04.")).toBeNull();
    expect(parseYearDate("14.13.")).toBeNull();
    expect(parseYearDate("03-14")).toBeNull();
    expect(parseYearDate("")).toBeNull();
  });
});
