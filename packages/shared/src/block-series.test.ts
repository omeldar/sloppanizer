import { describe, expect, it } from "vitest";
import { BlockDateChange, canRepeatPlan, CreateBlockSeries, todoForDate } from "./block-series.ts";

describe("todoForDate", () => {
  const chain = [
    { id: 1, anchor: "2026-11-02" },
    { id: 2, anchor: "2026-11-09" },
    { id: 3, anchor: null },
    { id: 4, anchor: "2026-11-23" },
  ];
  const idFor = (date: string) => todoForDate(chain, date)?.id;

  it("gives a date the newest todo dated on or before it", () => {
    expect(idFor("2026-11-02")).toBe(1);
    expect(idFor("2026-11-03")).toBe(1);
    expect(idFor("2026-11-10")).toBe(2);
    // The repeat skipped the 16th (done late): that date still belongs to the todo before.
    expect(idFor("2026-11-16")).toBe(2);
    expect(idFor("2026-11-23")).toBe(4);
  });

  it("gives later dates to the open todo and earlier ones to the first", () => {
    expect(idFor("2027-01-04")).toBe(4);
    expect(idFor("2026-10-26")).toBe(1);
  });

  it("is null for an empty chain and the last todo when none has a date", () => {
    expect(todoForDate([], "2026-11-02")).toBeNull();
    expect(todoForDate([{ id: 9, anchor: null }], "2026-11-02")?.id).toBe(9);
  });
});

describe("contract", () => {
  it("plans 5 minutes to 24 hours, like any block", () => {
    expect(
      CreateBlockSeries.safeParse({ startAt: "2026-11-02T08:00:00Z", endAt: "2026-11-02T09:00:00Z" }).success,
    ).toBe(true);
    expect(
      CreateBlockSeries.safeParse({ startAt: "2026-11-02T08:00:00Z", endAt: "2026-11-02T08:02:00Z" }).success,
    ).toBe(false);
  });

  it("cancels this one or this and following; all is deleting the planned time", () => {
    expect(BlockDateChange.safeParse({ scope: "following", cancelled: true }).success).toBe(true);
    expect(BlockDateChange.safeParse({ scope: "all", cancelled: true }).success).toBe(false);
  });

  it("plans ahead only for repeats on a schedule", () => {
    expect(canRepeatPlan({ every: "week", interval: 1, weekdays: ["mon"], basis: "schedule" })).toBe(true);
    expect(canRepeatPlan({ every: "day", interval: 3, basis: "done" })).toBe(false);
    expect(canRepeatPlan(null)).toBe(false);
  });
});
