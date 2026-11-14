import { describe, expect, it } from "vitest";
import { formatBytes, shortDate, tookText } from "./format.ts";

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
    expect(shortDate("2026-11-30", now)).toBe("30 Nov");
    expect(shortDate("2026-11-01", now)).toBe("1 Nov");
    expect(shortDate("2027-01-05", now)).toBe("5 Jan 2027");
  });
});
