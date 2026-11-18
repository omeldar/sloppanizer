import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatDateTime,
  formatDayMonth,
  addDays,
  localTimeToInstant,
  toLocalTime,
  daysBetween,
  daysSince,
  isCalendarDate,
  isValidTimeZone,
  startOfLocalDay,
  toLocalDate,
  weekDays,
} from "./dates.ts";

const PARIS = "Europe/Paris";

describe("toLocalDate", () => {
  it("uses the given zone, not the machine zone", () => {
    expect(toLocalDate("2026-11-11T23:30:00.000Z", PARIS)).toBe("2026-11-12");
    expect(toLocalDate("2026-11-11T23:30:00.000Z", "UTC")).toBe("2026-11-11");
    expect(toLocalDate("2026-11-12T03:00:00.000Z", "America/New_York")).toBe("2026-11-11");
  });

  it("handles month and year ends", () => {
    expect(toLocalDate("2026-01-31T23:00:00.000Z", PARIS)).toBe("2026-02-01");
    expect(toLocalDate("2026-12-31T22:59:59.999Z", PARIS)).toBe("2026-12-31");
    expect(toLocalDate("2026-12-31T23:00:00.000Z", PARIS)).toBe("2027-01-01");
  });

  it("follows the DST change in Paris (UTC+1 in winter, UTC+2 in summer)", () => {
    expect(toLocalDate("2026-03-28T23:00:00.000Z", PARIS)).toBe("2026-03-29");
    expect(toLocalDate("2026-03-29T21:59:00.000Z", PARIS)).toBe("2026-03-29");
    expect(toLocalDate("2026-03-29T22:00:00.000Z", PARIS)).toBe("2026-03-30");
    expect(toLocalDate("2026-10-24T22:00:00.000Z", PARIS)).toBe("2026-10-25");
    expect(toLocalDate("2026-10-25T22:59:00.000Z", PARIS)).toBe("2026-10-25");
    expect(toLocalDate("2026-10-25T23:00:00.000Z", PARIS)).toBe("2026-10-26");
  });

  it("rejects an invalid instant", () => {
    expect(() => toLocalDate("not a date", PARIS)).toThrow(RangeError);
  });
});

describe("calendar arithmetic", () => {
  it("counts whole days across month ends, leap days and DST changes", () => {
    expect(daysBetween("2026-01-31", "2026-03-01")).toBe(29);
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2);
    expect(daysBetween("2026-03-28", "2026-04-04")).toBe(7);
    expect(daysBetween("2026-10-24", "2026-10-31")).toBe(7);
    expect(daysBetween("2026-11-11", "2026-11-01")).toBe(-10);
  });

  it("adds days across month and year ends", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
  });

  it("daysSince uses the local date of the instant", () => {
    expect(daysSince("2026-10-31T23:30:00.000Z", "2026-11-01", PARIS)).toBe(0);
    expect(daysSince("2026-10-31T22:30:00.000Z", "2026-11-01", PARIS)).toBe(1);
  });

  it("validates calendar dates", () => {
    expect(isCalendarDate("2026-02-28")).toBe(true);
    expect(isCalendarDate("2026-02-29")).toBe(false);
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("2026-11-31")).toBe(false);
    expect(isCalendarDate("2026-1-01")).toBe(false);
    expect(() => daysBetween("2026-13-01", "2026-01-01")).toThrow(RangeError);
  });
});

describe("startOfLocalDay", () => {
  it("returns local midnight as a UTC instant, with the right offset each side of DST", () => {
    expect(startOfLocalDay("2026-03-28", PARIS).toISOString()).toBe("2026-03-27T23:00:00.000Z");
    expect(startOfLocalDay("2026-03-29", PARIS).toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(startOfLocalDay("2026-03-30", PARIS).toISOString()).toBe("2026-03-29T22:00:00.000Z");
    expect(startOfLocalDay("2026-10-25", PARIS).toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(startOfLocalDay("2026-10-26", PARIS).toISOString()).toBe("2026-10-25T23:00:00.000Z");
  });

  it("works for UTC and zones west of UTC", () => {
    expect(startOfLocalDay("2026-11-11", "UTC").toISOString()).toBe("2026-11-11T00:00:00.000Z");
    expect(startOfLocalDay("2026-11-11", "America/New_York").toISOString()).toBe("2026-11-11T05:00:00.000Z");
  });

  it("round-trips with toLocalDate for every day of the DST weeks", () => {
    for (const start of ["2026-03-26", "2026-10-22"]) {
      for (let i = 0; i < 7; i++) {
        const date = addDays(start, i);
        const midnight = startOfLocalDay(date, PARIS).getTime();
        expect(toLocalDate(midnight, PARIS)).toBe(date);
        expect(toLocalDate(midnight - 1, PARIS)).toBe(addDays(date, -1));
      }
    }
  });
});

describe("isValidTimeZone", () => {
  it("knows real zones only", () => {
    expect(isValidTimeZone(PARIS)).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });
});

describe("weekDays", () => {
  it("returns Monday to Sunday of the week of a calendar date", () => {
    expect(weekDays("2026-11-12", PARIS)).toEqual([
      "2026-11-09",
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
      "2026-11-13",
      "2026-11-14",
      "2026-11-15",
    ]);
    expect(weekDays("2026-11-09", PARIS)[0]).toBe("2026-11-09");
    expect(weekDays("2026-11-15", PARIS)[0]).toBe("2026-11-09");
  });

  it("keeps seven distinct days across the Paris DST weeks", () => {
    expect(weekDays("2026-03-29", PARIS)).toEqual([
      "2026-03-23",
      "2026-03-24",
      "2026-03-25",
      "2026-03-26",
      "2026-03-27",
      "2026-03-28",
      "2026-03-29",
    ]);
    expect(weekDays("2026-10-25", PARIS)).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
    ]);
  });

  it("spans the year end", () => {
    expect(weekDays("2026-12-31", PARIS)).toEqual([
      "2026-12-28",
      "2026-12-29",
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
      "2027-01-03",
    ]);
  });

  it("turns an instant into its local date first", () => {
    // Sunday 23:30 in Paris (summer time) is still the old week; 00:30 Monday is the next one.
    expect(weekDays("2026-03-29T21:30:00.000Z", PARIS)[0]).toBe("2026-03-23");
    expect(weekDays("2026-03-29T22:30:00.000Z", PARIS)[0]).toBe("2026-03-30");
    expect(weekDays(new Date("2026-03-29T22:30:00.000Z"), "UTC")[0]).toBe("2026-03-23");
  });
});

describe("formatDate", () => {
  it("writes day, month and year with two-digit day and month", () => {
    expect(formatDate("2026-10-03")).toBe("03.10.2026");
    expect(formatDate("2026-01-09")).toBe("09.01.2026");
    expect(formatDate("2026-12-31")).toBe("31.12.2026");
    expect(formatDate("2027-01-01")).toBe("01.01.2027");
  });

  it("leaves anything that is not a calendar date alone", () => {
    expect(formatDate("")).toBe("");
    expect(formatDate("2026-11-12T10:00:00Z")).toBe("2026-11-12T10:00:00Z");
  });
});

describe("formatDayMonth", () => {
  it("drops the year and keeps the trailing dot", () => {
    expect(formatDayMonth("2026-10-03")).toBe("03.10.");
    expect(formatDayMonth("2026-01-09")).toBe("09.01.");
    expect(formatDayMonth("2026-12-31")).toBe("31.12.");
  });

  it("also takes a year date (MM-DD) from a yearly repeat", () => {
    expect(formatDayMonth("03-14")).toBe("14.03.");
    expect(formatDayMonth("02-29")).toBe("29.02.");
    expect(formatDayMonth("3-14")).toBe("3-14");
  });
});

describe("formatDateTime", () => {
  it("formats the wall clock in the zone with minutes", () => {
    expect(formatDateTime("2026-11-12T13:03:59.000Z", PARIS)).toBe("12.11.2026 14:03");
    expect(formatDateTime("2026-07-01T22:15:00.000Z", PARIS)).toBe("02.07.2026 00:15");
    expect(formatDateTime("2026-12-31T23:00:00.000Z", "UTC")).toBe("31.12.2026 23:00");
  });

  it("takes the date of the zone across a year boundary", () => {
    expect(formatDateTime("2026-12-31T23:30:00.000Z", PARIS)).toBe("01.01.2027 00:30");
    expect(formatDateTime("2027-01-01T03:00:00.000Z", "America/New_York")).toBe("31.12.2026 22:00");
  });
});

describe("localTimeToInstant", () => {
  it("turns local wall time into UTC, also around DST", () => {
    expect(localTimeToInstant("2026-11-12", "08:30", "Europe/Zurich").toISOString()).toBe(
      "2026-11-12T07:30:00.000Z",
    );
    expect(localTimeToInstant("2026-07-01", "08:30", "Europe/Zurich").toISOString()).toBe(
      "2026-07-01T06:30:00.000Z",
    );
    // 2026-03-29 02:30 does not exist in Zurich: an hour later.
    expect(localTimeToInstant("2026-03-29", "02:30", "Europe/Zurich").toISOString()).toBe(
      "2026-03-29T01:30:00.000Z",
    );
    expect(localTimeToInstant("2026-11-12", "23:15", "America/New_York").toISOString()).toBe(
      "2026-11-13T04:15:00.000Z",
    );
    expect(toLocalTime("2026-11-12T07:30:00.000Z", "Europe/Zurich")).toBe("08:30");
    expect(() => localTimeToInstant("2026-11-12", "25:00", "UTC")).toThrow("Not a time of day");
  });
});
