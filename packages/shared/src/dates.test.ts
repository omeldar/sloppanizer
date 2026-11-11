import { describe, expect, it } from "vitest";
import {
  addDays,
  daysBetween,
  daysSince,
  isCalendarDate,
  isValidTimeZone,
  startOfLocalDay,
  toLocalDate,
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
