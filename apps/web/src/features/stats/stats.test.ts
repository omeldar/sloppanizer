import { describe, expect, it } from "vitest";
import { heatStep, hoursText, niceScale, periodOf, presetRange } from "./stats.ts";

describe("periods", () => {
  // Wednesday.
  const today = "2026-11-18";

  it("ends every preset today", () => {
    expect(presetRange("week", today)).toEqual({ from: "2026-11-16", to: today });
    expect(presetRange("4w", today)).toEqual({ from: "2026-10-22", to: today });
    expect(presetRange("3m", today)).toEqual({ from: "2026-08-20", to: today });
    expect(presetRange("year", today)).toEqual({ from: "2026-01-01", to: today });
  });

  it("reads a preset or a custom range from the URL, else 4 weeks", () => {
    expect(periodOf({}, today)).toEqual({ preset: "4w", from: "2026-10-22", to: today });
    expect(periodOf({ period: "year" }, today).from).toBe("2026-01-01");
    expect(periodOf({ from: "2026-11-01", to: "2026-11-07" }, today)).toEqual({
      preset: "custom",
      from: "2026-11-01",
      to: "2026-11-07",
    });
    expect(periodOf({ from: "2026-11-07", to: "2026-11-01" }, today).preset).toBe("4w");
  });
});

describe("scales and labels", () => {
  it("rounds the axis top to a clean step", () => {
    expect(niceScale(270)).toEqual({ top: 300, ticks: [0, 100, 200, 300] });
    expect(niceScale(7)).toEqual({ top: 8, ticks: [0, 2, 4, 6, 8] });
    expect(niceScale(0)).toEqual({ top: 1, ticks: [0, 1] });
  });

  it("puts values on five steps, nothing on none", () => {
    expect([0, 1, 20, 59, 60].map((v) => heatStep(v, 60))).toEqual([0, 1, 2, 5, 5]);
  });

  it("shows hours with one decimal below ten", () => {
    expect([0, 30, 270, 754].map(hoursText)).toEqual(["0 h", "0.5 h", "4.5 h", "13 h"]);
  });
});
