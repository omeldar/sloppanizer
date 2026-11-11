import { describe, expect, it } from "vitest";
import { formatDuration, todoDurationMs } from "./duration.ts";

const M = 60_000;
const H = 60 * M;
const D = 24 * H;

describe("formatDuration", () => {
  it.each([
    [0, "0m"],
    [59_999, "0m"],
    [45 * M, "45m"],
    [H - 1, "59m"],
    [H, "1h"],
    [3 * H + 20 * M, "3h 20m"],
    [D - 1, "23h 59m"],
    [D, "1d"],
    [3 * D + 4 * H + 59 * M, "3d 4h"],
    [14 * D - 1, "13d 23h"],
    [14 * D, "14d"],
    [23 * D + 22 * H, "23d"],
    [400 * D, "400d"],
  ])("%d ms -> %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });

  it("treats negative and invalid values as zero", () => {
    expect(formatDuration(-5 * H)).toBe("0m");
    expect(formatDuration(Number.NaN)).toBe("0m");
  });
});

describe("todoDurationMs", () => {
  it("is doneAt minus createdAt, null when not done, never negative", () => {
    expect(todoDurationMs("2026-11-01T10:00:00.000Z", "2026-11-04T14:00:00.000Z")).toBe(3 * D + 4 * H);
    expect(todoDurationMs("2026-11-01T10:00:00.000Z", null)).toBeNull();
    expect(todoDurationMs("2026-11-02T10:00:00.000Z", "2026-11-01T10:00:00.000Z")).toBe(0);
  });
});
