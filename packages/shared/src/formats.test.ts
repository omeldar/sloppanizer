import { describe, expect, it } from "vitest";
import { formatDateAs, formatDayMonthAs, formatTimeAs, parseDateAs, parseTime, regionOf } from "./formats.ts";

describe("formats", () => {
  it("shows a date in each format", () => {
    expect(formatDateAs("2001-09-11", "dmy.")).toBe("11.09.2001");
    expect(formatDateAs("2001-09-11", "dmy/")).toBe("11/09/2001");
    expect(formatDateAs("2001-09-11", "mdy/")).toBe("09/11/2001");
    expect(formatDateAs("2001-09-11", "ymd-")).toBe("2001-09-11");
    expect(formatDayMonthAs("2001-09-11", "dmy.")).toBe("11.09.");
    expect(formatDayMonthAs("09-11", "mdy/")).toBe("09/11");
  });

  it("shows times in 24h or 12h", () => {
    expect(formatTimeAs("15:00", "24h")).toBe("15:00");
    expect(formatTimeAs("15:00", "12h")).toBe("3:00 PM");
    expect(formatTimeAs("00:30", "12h")).toBe("12:30 AM");
    expect(formatTimeAs("12:00", "12h")).toBe("12:00 PM");
  });

  it("reads typed dates in the account's format, and ISO always", () => {
    expect(parseDateAs("11.09.2001", "dmy.", 2026)).toBe("2001-09-11");
    expect(parseDateAs("11.9.01", "dmy.", 2026)).toBe("2001-09-11");
    expect(parseDateAs("11.9", "dmy.", 2026)).toBe("2026-09-11");
    expect(parseDateAs("9/11/2001", "mdy/", 2026)).toBe("2001-09-11");
    expect(parseDateAs("2001-09-11", "mdy/", 2026)).toBe("2001-09-11");
    expect(parseDateAs("31.02.2026", "dmy.", 2026)).toBeNull();
    expect(parseDateAs("11.09.20", "dmy.", 2026)).toBe("2020-09-11");
    expect(parseDateAs("11.09.202", "dmy.", 2026)).toBeNull();
    expect(parseDateAs("hello", "dmy.", 2026)).toBeNull();
  });

  it("reads typed times, 24h and 12h", () => {
    expect(parseTime("15:00")).toBe("15:00");
    expect(parseTime("15.30")).toBe("15:30");
    expect(parseTime("1530")).toBe("15:30");
    expect(parseTime("9")).toBe("09:00");
    expect(parseTime("3pm")).toBe("15:00");
    expect(parseTime("3:30 PM")).toBe("15:30");
    expect(parseTime("12 am")).toBe("00:00");
    expect(parseTime("3 p.m.")).toBe("15:00");
    expect(parseTime("24:00")).toBe("24:00");
    expect(parseTime("25:00")).toBeNull();
    expect(parseTime("13pm")).toBeNull();
  });

  it("guesses a region from the browser locale", () => {
    expect(regionOf("de-CH")).toBe("ch");
    expect(regionOf("en-US")).toBe("us");
    expect(regionOf("en-GB")).toBe("gb");
    expect(regionOf(undefined)).toBe("ch");
  });
});
