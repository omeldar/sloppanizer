import { describe, expect, it } from "vitest";
import { formatBytes, tookText } from "./format.ts";

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
