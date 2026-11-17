import { describe, expect, it } from "vitest";
import {
  absoluteDate,
  absoluteTime,
  dayLabel,
  formatBytes,
  formatMonth,
  shortDate,
  tookText,
  weekdayName,
} from "./format.ts";

describe("formatBytes", () => {
  it("keeps bytes whole and uses one decimal from KB on", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(52_000)).toBe("50.8 KB");
    expect(formatBytes(13 * 1024 ** 2)).toBe("13.0 MB");
    expect(formatBytes(1024 ** 3 + 1)).toBe("1.0 GB");
  });
});

describe("tookText", () => {
  it("says how long a done todo took and stays empty otherwise", () => {
    expect(tookText({ status: "done", durationMs: 52 * 3_600_000 })).toBe("took 2d 4h");
    expect(tookText({ status: "done", durationMs: null })).toBeUndefined();
    expect(tookText({ status: "open", durationMs: 3_600_000 })).toBeUndefined();
  });
});

describe("shortDate", () => {
  const now = new Date("2026-11-14T10:00:00Z");
  it("names near days and shortens the rest", () => {
    expect(["2026-11-14", "2026-11-15", "2026-11-13"].map((d) => shortDate(d, now))).toEqual([
      "Today",
      "Tomorrow",
      "Yesterday",
    ]);
    expect(shortDate("2026-11-18", now)).toBe("Wed");
    expect(shortDate("2026-11-30", now)).toBe("30.11.");
    expect(shortDate("2026-11-01", now)).toBe("01.11.");
    expect(shortDate("2026-02-03", now)).toBe("03.02.");
  });

  it("writes the full date for another year, also right across new year", () => {
    expect(shortDate("2027-01-05", now)).toBe("05.01.2027");
    expect(shortDate("2025-11-14", now)).toBe("14.11.2025");
    const newYearsEve = new Date("2026-12-31T10:00:00Z");
    expect(shortDate("2027-01-09", newYearsEve)).toBe("09.01.2027");
    expect(shortDate("2026-12-20", newYearsEve)).toBe("20.12.");
  });

  it("does not depend on the browser language", () => {
    const formatted = ["2026-03-04", "2026-10-03"].map((d) => shortDate(d, now));
    expect(formatted.join(" ")).not.toMatch(/[a-z]/i);
  });
});

describe("day labels", () => {
  it("puts the English short weekday before the short date", () => {
    expect(weekdayName("2026-11-16")).toBe("Mon");
    expect(dayLabel("2026-11-16")).toBe("Mon 16.11.");
    expect(dayLabel("2027-01-03")).toBe("Sun 03.01.");
  });
});

describe("formatMonth", () => {
  it("writes month and year with a two-digit month", () => {
    expect(formatMonth("2026-03")).toBe("03.2026");
    expect(formatMonth("2026-11")).toBe("11.2026");
  });
});

describe("absoluteDate", () => {
  it("gives the local day of an instant in the full format", () => {
    // Midday UTC is the same calendar day in nearly every zone the tests run in.
    expect(absoluteDate("2026-01-05T12:00:00Z")).toBe("05.01.2026");
  });

  it("writes date and 24-hour time without month names", () => {
    expect(absoluteTime("2026-01-05T12:07:00Z")).toMatch(/^05\.01\.2026 \d\d:07$/);
  });
});
