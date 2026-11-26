import { describe, expect, it } from "vitest";
import { normalizeRecurrence, type RecurrenceRuleInput } from "./recurrence.ts";
import {
  describeSeries,
  expandSeries,
  firstSeriesDate,
  isSeriesDate,
  lastStartBefore,
  nextSeriesOccurrence,
  occurrenceOn,
  type SeriesException,
  type SeriesSpan,
  seriesDates,
  seriesProblem,
  shiftRule,
  splitSeries,
} from "./series.ts";

const ZURICH = "Europe/Zurich";

/** A series like the server stores it: the rule normalized from the first date. */
function series(
  rule: RecurrenceRuleInput,
  startsOn: string,
  more: Partial<Omit<SeriesSpan, "rule" | "startsOn">> = {},
): SeriesSpan {
  return {
    id: 1,
    rule: normalizeRecurrence(rule, startsOn),
    startsOn,
    endsOn: null,
    startTime: "09:00",
    durationMinutes: 15,
    ...more,
  };
}

/** Weekly on Thursday 09:00 to 09:15 from 05.11.2026. */
const thursdays = series({ every: "week" }, "2026-11-05");

const moved = (occursOn: string, startAt: string, endAt: string, seriesId = 1): SeriesException => ({
  seriesId,
  occursOn,
  kind: "moved",
  startAt,
  endAt,
});
const cancelled = (occursOn: string, seriesId = 1): SeriesException => ({
  seriesId,
  occursOn,
  kind: "cancelled",
  startAt: null,
  endAt: null,
});

const brief = (list: { occursOn: string; startAt: string; status: string }[]) =>
  list.map((o) => `${o.occursOn} ${o.startAt} ${o.status}`);

const at = (iso: string) => new Date(iso);

const weekly = (weekdays: RecurrenceRuleInput["weekdays"], interval = 1) =>
  normalizeRecurrence({ every: "week", interval, weekdays }, "2026-11-02");

const month = (monthDay: number) => normalizeRecurrence({ every: "month", monthDay }, "2026-11-02");

describe("seriesDates", () => {
  it("lists every Monday and Thursday of a weekly rule in the range", () => {
    const s = series({ every: "week", weekdays: ["thu", "mon"] }, "2026-11-02");
    expect(seriesDates(s, "2026-11-01", "2026-11-15")).toEqual([
      "2026-11-02",
      "2026-11-05",
      "2026-11-09",
      "2026-11-12",
    ]);
  });

  it("skips the weeks in between for every 2 weeks, also when the first date is not a match", () => {
    const s = series({ every: "week", interval: 2, weekdays: ["thu"] }, "2026-11-03");
    expect(isSeriesDate(s, "2026-11-03")).toBe(false);
    expect(seriesDates(s, "2026-10-01", "2026-12-10")).toEqual(["2026-11-05", "2026-11-19", "2026-12-03"]);
  });

  it("finds the last Friday of each month", () => {
    const s = series({ every: "month", monthWeekday: { nth: -1, weekday: "fri" } }, "2026-11-27");
    expect(seriesDates(s, "2026-11-01", "2027-02-28")).toEqual([
      "2026-11-27",
      "2026-12-25",
      "2027-01-29",
      "2027-02-26",
    ]);
  });

  it("stops at the last date and never starts before the first one", () => {
    const s = { ...thursdays, endsOn: "2026-11-19" };
    expect(seriesDates(s, "2026-10-01", "2026-12-31")).toEqual(["2026-11-05", "2026-11-12", "2026-11-19"]);
    expect(seriesDates(s, "2026-11-20", "2026-12-31")).toEqual([]);
    expect(isSeriesDate(s, "2026-10-29")).toBe(false);
    expect(isSeriesDate(s, "2026-11-26")).toBe(false);
  });
});

describe("expandSeries", () => {
  it("keeps the wall-clock time across the DST changes in Zurich", () => {
    expect(brief(expandSeries([thursdays], [], "2026-11-05", "2026-11-05", ZURICH))).toEqual([
      "2026-11-05 2026-11-05T08:00:00.000Z scheduled",
    ]);
    const autumn = series({ every: "week" }, "2026-10-15");
    expect(
      expandSeries([autumn], [], "2026-10-19", "2026-11-01", ZURICH).map((o) => [o.startAt, o.endAt]),
    ).toEqual([
      ["2026-10-22T07:00:00.000Z", "2026-10-22T07:15:00.000Z"],
      ["2026-10-29T08:00:00.000Z", "2026-10-29T08:15:00.000Z"],
    ]);
    const spring = series({ every: "week" }, "2026-03-19");
    expect(expandSeries([spring], [], "2026-03-23", "2026-04-05", ZURICH).map((o) => o.startAt)).toEqual([
      "2026-03-26T08:00:00.000Z",
      "2026-04-02T07:00:00.000Z",
    ]);
  });

  it("shows a date moved into the range and leaves out one moved out of it", () => {
    const exceptions = [moved("2026-11-12", "2026-11-17T10:00:00.000Z", "2026-11-17T10:15:00.000Z")];
    expect(brief(expandSeries([thursdays], exceptions, "2026-11-16", "2026-11-22", ZURICH))).toEqual([
      "2026-11-12 2026-11-17T10:00:00.000Z moved",
      "2026-11-19 2026-11-19T08:00:00.000Z scheduled",
    ]);
    expect(expandSeries([thursdays], exceptions, "2026-11-09", "2026-11-15", ZURICH)).toEqual([]);
  });

  it("marks cancelled dates and ignores exceptions of dates the series does not have", () => {
    const exceptions = [
      cancelled("2026-11-12"),
      moved("2026-11-13", "2026-11-13T10:00:00.000Z", "2026-11-13T10:15:00.000Z"),
      moved("2026-11-19", "2026-11-13T12:00:00.000Z", "2026-11-13T12:15:00.000Z", 2),
    ];
    expect(brief(expandSeries([thursdays], exceptions, "2026-11-09", "2026-11-15", ZURICH))).toEqual([
      "2026-11-12 2026-11-12T08:00:00.000Z cancelled",
    ]);
  });

  it("includes a late meeting of the day before that runs into the first day", () => {
    const late = series({ every: "day" }, "2026-11-10", { startTime: "23:30", durationMinutes: 60 });
    expect(expandSeries([late], [], "2026-11-12", "2026-11-12", ZURICH).map((o) => o.occursOn)).toEqual([
      "2026-11-11",
      "2026-11-12",
    ]);
  });

  it("merges the segments of a split series by start", () => {
    const { head, tail } = splitSeries(thursdays, "2026-11-19");
    const later = { ...tail, id: 2, rule: normalizeRecurrence({ every: "week" }, "2026-11-20") };
    const segments = [head as SeriesSpan, { ...later, startsOn: "2026-11-20", startTime: "14:00" }];
    expect(brief(expandSeries(segments, [], "2026-11-09", "2026-11-22", ZURICH))).toEqual([
      "2026-11-12 2026-11-12T08:00:00.000Z scheduled",
      "2026-11-20 2026-11-20T13:00:00.000Z scheduled",
    ]);
    expect(occurrenceOn(segments, [], "2026-11-20", ZURICH)?.seriesId).toBe(2);
    expect(occurrenceOn(segments, [], "2026-11-19", ZURICH)).toBeNull();
  });
});

describe("nextSeriesOccurrence", () => {
  it("returns the running meeting, then the next one", () => {
    expect(nextSeriesOccurrence([thursdays], [], at("2026-11-12T08:05:00.000Z"), ZURICH)?.occursOn).toBe(
      "2026-11-12",
    );
    expect(nextSeriesOccurrence([thursdays], [], at("2026-11-12T08:15:00.000Z"), ZURICH)?.occursOn).toBe(
      "2026-11-19",
    );
  });

  it("skips cancelled dates and takes a moved one at its new time", () => {
    const after = at("2026-11-13T00:00:00.000Z");
    expect(nextSeriesOccurrence([thursdays], [cancelled("2026-11-19")], after, ZURICH)?.occursOn).toBe(
      "2026-11-26",
    );
    const exceptions = [
      cancelled("2026-11-19"),
      moved("2026-11-26", "2026-11-18T10:00:00.000Z", "2026-11-18T10:15:00.000Z"),
    ];
    expect(nextSeriesOccurrence([thursdays], exceptions, after, ZURICH)).toMatchObject({
      occursOn: "2026-11-26",
      startAt: "2026-11-18T10:00:00.000Z",
      status: "moved",
    });
    // A date moved later than the next scheduled one does not hide it.
    const late = [moved("2026-11-19", "2026-11-30T10:00:00.000Z", "2026-11-30T10:15:00.000Z")];
    expect(nextSeriesOccurrence([thursdays], late, after, ZURICH)?.occursOn).toBe("2026-11-26");
  });

  it("returns null after the last date", () => {
    const ended = { ...thursdays, endsOn: "2026-11-12" };
    expect(nextSeriesOccurrence([ended], [], at("2026-11-13T00:00:00.000Z"), ZURICH)).toBeNull();
  });
});

describe("lastStartBefore", () => {
  it("is the start of the last meeting date before now", () => {
    expect(lastStartBefore(thursdays, new Date("2026-11-18T10:00:00.000Z"), ZURICH)).toBe(
      "2026-11-12T08:00:00.000Z",
    );
    expect(lastStartBefore(thursdays, new Date("2026-11-19T07:59:59.000Z"), ZURICH)).toBe(
      "2026-11-12T08:00:00.000Z",
    );
    expect(lastStartBefore(thursdays, new Date("2026-11-19T08:00:01.000Z"), ZURICH)).toBe(
      "2026-11-19T08:00:00.000Z",
    );
  });

  it("follows the pattern back when the series starts in the future", () => {
    const now = new Date("2026-11-18T10:00:00.000Z");
    expect(lastStartBefore(series({ every: "week" }, "2026-12-03"), now, ZURICH)).toBe(
      "2026-11-12T08:00:00.000Z",
    );
    expect(lastStartBefore(series({ every: "week", interval: 2 }, "2026-12-03"), now, ZURICH)).toBe(
      "2026-11-05T08:00:00.000Z",
    );
    expect(lastStartBefore(series({ every: "month" }, "2027-01-15"), now, ZURICH)).toBe(
      "2026-11-15T08:00:00.000Z",
    );
    expect(lastStartBefore(series({ every: "day", interval: 3 }, "2026-11-20"), now, ZURICH)).toBe(
      "2026-11-17T08:00:00.000Z",
    );
  });
});

describe("splitSeries", () => {
  it("ends the first part the day before and starts the second on the date", () => {
    const { head, tail } = splitSeries(thursdays, "2026-11-19");
    expect(head).toMatchObject({ startsOn: "2026-11-05", endsOn: "2026-11-18" });
    expect(tail).toMatchObject({ startsOn: "2026-11-19", endsOn: null });
    expect(seriesDates(head as SeriesSpan, "2026-11-01", "2026-11-30")).toEqual(["2026-11-05", "2026-11-12"]);
  });

  it("has no first part when split at the first date", () => {
    expect(splitSeries(thursdays, "2026-11-05").head).toBeNull();
  });
});

describe("shiftRule", () => {
  it("turns the weekdays of a weekly rule", () => {
    expect(shiftRule(weekly(["mon", "thu"]), 1)?.weekdays).toEqual(["tue", "fri"]);
    expect(shiftRule(weekly(["thu", "sun"]), -4)?.weekdays).toEqual(["wed", "sun"]);
    expect(shiftRule(weekly(["mon", "thu"], 2), 1)?.weekdays).toEqual(["tue", "fri"]);
  });

  it("refuses a gap of weeks when a weekday would cross into another week", () => {
    expect(shiftRule(weekly(["mon", "thu"], 2), 4)).toBeNull();
    expect(shiftRule(weekly(["mon", "thu"]), 4)?.weekdays).toEqual(["mon", "fri"]);
  });

  it("keeps daily rules, moves a day of the month within 1..28 and refuses the rest", () => {
    const daily = normalizeRecurrence({ every: "day", interval: 2 }, "2026-11-02");
    expect(shiftRule(daily, 3)).toEqual(daily);
    expect(shiftRule(month(10), 3)?.monthDay).toBe(13);
    expect(shiftRule(month(27), 3)).toBeNull();
    expect(shiftRule(month(-1), -1)).toBeNull();
    const nth = normalizeRecurrence(
      { every: "month", monthWeekday: { nth: 2, weekday: "tue" } },
      "2026-11-10",
    );
    expect(shiftRule(nth, 1)).toBeNull();
    expect(shiftRule(nth, 0)).toEqual(nth);
    expect(shiftRule(normalizeRecurrence({ every: "year" }, "2026-11-02"), 1)).toBeNull();
  });

  it("moves every date by the delta when the new segment starts at the moved date", () => {
    const rule = weekly(["mon", "thu"]);
    const old = series({ every: "week", weekdays: ["mon", "thu"] }, "2026-11-02");
    const shifted = { ...old, rule: shiftRule(rule, 1) as SeriesSpan["rule"], startsOn: "2026-11-10" };
    expect(seriesDates(old, "2026-11-09", "2026-11-20")).toEqual([
      "2026-11-09",
      "2026-11-12",
      "2026-11-16",
      "2026-11-19",
    ]);
    expect(seriesDates(shifted, "2026-11-09", "2026-11-21")).toEqual([
      "2026-11-10",
      "2026-11-13",
      "2026-11-17",
      "2026-11-20",
    ]);
  });
});

describe("describeSeries", () => {
  it("names the repeat, the time and the last date", () => {
    expect(describeSeries(thursdays)).toBe("every week on Thu, 09:00–09:15");
    expect(
      describeSeries({ ...thursdays, endsOn: "2026-12-31", startTime: "23:30", durationMinutes: 60 }),
    ).toBe("every week on Thu until 31.12.2026, 23:30–00:30");
  });

  it("says once for a one-time meeting, a segment with a single date", () => {
    expect(describeSeries({ ...thursdays, endsOn: thursdays.startsOn })).toBe(
      `once on ${thursdays.startsOn.split("-").toReversed().join(".")}, 09:00–09:15`,
    );
  });
});

const starts = (s: SeriesSpan, from: string, to: string) =>
  expandSeries([s], [], from, to, ZURICH).map((o) => `${o.occursOn} ${o.startAt.slice(11, 16)}`);

describe("the days the clocks change in Zurich", () => {
  it("keeps 09:00 local on the Sundays of 29.03. and 25.10.2026 and the days around them", () => {
    const daily = series({ every: "day" }, "2026-03-01");
    expect(starts(daily, "2026-03-28", "2026-03-30")).toEqual([
      "2026-03-28 08:00",
      "2026-03-29 07:00",
      "2026-03-30 07:00",
    ]);
    const autumn = series({ every: "day" }, "2026-10-01");
    expect(starts(autumn, "2026-10-24", "2026-10-26")).toEqual([
      "2026-10-24 07:00",
      "2026-10-25 08:00",
      "2026-10-26 08:00",
    ]);
  });

  it("still lasts its length on the day with 23 or 25 hours", () => {
    const hour = series({ every: "day" }, "2026-03-01", { startTime: "01:30", durationMinutes: 120 });
    const [spring] = expandSeries([hour], [], "2026-03-29", "2026-03-29", ZURICH);
    expect((Date.parse(spring?.endAt ?? "") - Date.parse(spring?.startAt ?? "")) / 60_000).toBe(120);
    const [autumn] = expandSeries(
      [{ ...hour, startsOn: "2026-10-01" }],
      [],
      "2026-10-25",
      "2026-10-25",
      ZURICH,
    );
    expect((Date.parse(autumn?.endAt ?? "") - Date.parse(autumn?.startAt ?? "")) / 60_000).toBe(120);
  });

  it("gives a time that does not exist (02:30 on 29.03.) one start, on that day, and keeps the weekly rhythm", () => {
    const sundays = series({ every: "week" }, "2026-03-22", { startTime: "02:30" });
    const list = expandSeries([sundays], [], "2026-03-22", "2026-04-05", ZURICH);
    expect(list.map((o) => o.occursOn)).toEqual(["2026-03-22", "2026-03-29", "2026-04-05"]);
    const skipped = list[1];
    expect(skipped?.startAt.slice(0, 10)).toBe("2026-03-29");
    // An hour of the wrong day would put it at 01:30 or 03:30 local, never on another date.
    expect(new Date(skipped?.startAt ?? "").getTime()).toBeGreaterThanOrEqual(
      Date.parse("2026-03-29T00:30:00Z"),
    );
    expect(new Date(skipped?.startAt ?? "").getTime()).toBeLessThanOrEqual(
      Date.parse("2026-03-29T02:30:00Z"),
    );
  });

  it("gives a time that happens twice (02:30 on 25.10.) exactly one start", () => {
    const sundays = series({ every: "week" }, "2026-10-18", { startTime: "02:30" });
    const list = expandSeries([sundays], [], "2026-10-25", "2026-10-25", ZURICH);
    expect(list).toHaveLength(1);
    expect(list[0]?.startAt.slice(0, 10)).toBe("2026-10-25");
  });

  it("finds the last start before now across the change", () => {
    const sundays = series({ every: "week" }, "2026-03-22");
    expect(lastStartBefore(sundays, new Date("2026-03-30T10:00:00.000Z"), ZURICH)).toBe(
      "2026-03-29T07:00:00.000Z",
    );
    // 08:30 UTC on 25.10. is 09:30 local: the 09:00 start of that day has passed.
    const autumn = series({ every: "week" }, "2026-10-18");
    expect(lastStartBefore(autumn, new Date("2026-10-25T08:30:00.000Z"), ZURICH)).toBe(
      "2026-10-25T08:00:00.000Z",
    );
    expect(lastStartBefore(autumn, new Date("2026-10-25T07:30:00.000Z"), ZURICH)).toBe(
      "2026-10-18T07:00:00.000Z",
    );
  });
});

describe("more repeat patterns", () => {
  it("handles the last Friday in months with four and five Fridays, and a leap February", () => {
    const s = series({ every: "month", monthWeekday: { nth: -1, weekday: "fri" } }, "2026-10-30");
    expect(seriesDates(s, "2026-10-01", "2026-10-31")).toEqual(["2026-10-30"]);
    const leap = series({ every: "month", monthWeekday: { nth: -1, weekday: "fri" } }, "2028-01-28");
    expect(seriesDates(leap, "2028-02-01", "2028-03-31")).toEqual(["2028-02-25", "2028-03-31"]);
  });

  it("keeps every 2 weeks over the new year and lets ends_on fall between two dates", () => {
    const s = series({ every: "week", interval: 2, weekdays: ["thu"] }, "2026-12-17", {
      endsOn: "2027-01-06",
    });
    expect(seriesDates(s, "2026-12-01", "2027-02-01")).toEqual(["2026-12-17", "2026-12-31"]);
  });

  it("includes the ends_on day itself and nothing on the day after", () => {
    const s = series({ every: "month", monthWeekday: { nth: -1, weekday: "fri" } }, "2026-11-27", {
      endsOn: "2026-12-25",
    });
    expect(seriesDates(s, "2026-11-01", "2027-03-01")).toEqual(["2026-11-27", "2026-12-25"]);
    expect(isSeriesDate({ ...s, endsOn: "2026-12-24" }, "2026-12-25")).toBe(false);
  });
});

const daily = (startsOn: string, endsOn: string | null) => ({
  ...series({ every: "day" }, startsOn),
  endsOn,
});

describe("seriesProblem", () => {
  it("accepts a repeat with a date inside ten years", () => {
    expect(seriesProblem(daily("2026-11-12", null))).toBeNull();
    expect(seriesProblem(daily("2026-11-12", "2036-11-12"))).toBeNull();
  });

  it("refuses long, far and empty repeats right away, without walking their dates", () => {
    const started = performance.now();
    expect(seriesProblem(daily("2000-01-01", "9999-12-31"))).toBe("Pick dates between 1900 and 2999.");
    expect(seriesProblem(daily("2000-01-01", "2999-12-31"))).toMatch(/at most 10 years/);
    expect(seriesProblem(daily("1899-12-31", null))).toBe("Pick dates between 1900 and 2999.");
    expect(seriesProblem(daily("2026-11-12", "2026-11-11"))).toMatch(/must not end before/);
    const noThursday = {
      ...series({ every: "week", weekdays: ["thu"] }, "2026-11-16"),
      endsOn: "2026-11-18",
    };
    expect(seriesProblem(noThursday)).toBe(
      "The repeat has no date from 16.11.2026 to 18.11.2026. Change the days or the dates.",
    );
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("finds the first date from a day on", () => {
    expect(firstSeriesDate(thursdays)).toBe("2026-11-05");
    expect(firstSeriesDate(thursdays, "2026-11-06")).toBe("2026-11-12");
    expect(firstSeriesDate({ ...thursdays, endsOn: "2026-11-11" }, "2026-11-06")).toBeNull();
  });
});
