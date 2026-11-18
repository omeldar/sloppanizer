import { describe, expect, it } from "vitest";
import { normalizeRecurrence, type RecurrenceRuleInput } from "./recurrence.ts";
import {
  describeSeries,
  expandSeries,
  isSeriesDate,
  lastStartBefore,
  nextSeriesOccurrence,
  occurrenceOn,
  type SeriesException,
  type SeriesSpan,
  seriesDates,
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
});
