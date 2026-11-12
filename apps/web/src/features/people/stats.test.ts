import { describe, expect, it } from "vitest";
import { barParts, peopleStatsParams, periodRange } from "./stats.ts";

describe("periodRange", () => {
  const today = "2026-11-12";
  it("counts today as the last day of the period", () => {
    expect(periodRange({ period: "30d" }, today)).toEqual({ from: "2026-10-14", to: today });
    expect(periodRange({ period: "90d" }, today)).toEqual({ from: "2026-08-15", to: today });
  });

  it("takes the last 12 months by default", () => {
    expect(periodRange({}, today)).toEqual({ from: "2025-11-13", to: today });
    expect(periodRange({}, "2028-02-29")).toEqual({ from: "2027-03-02", to: "2028-02-29" });
  });

  it("has no bounds for all time and only the given ones for custom", () => {
    expect(periodRange({ period: "all" }, today)).toEqual({});
    expect(periodRange({ period: "custom", from: "2026-01-01" }, today)).toEqual({ from: "2026-01-01" });
    // A from/to left in the URL does nothing without the custom period.
    expect(periodRange({ period: "30d", from: "2020-01-01" }, today).from).toBe("2026-10-14");
  });
});

describe("peopleStatsParams", () => {
  const ids = (slug: string) => (slug === "home-lab" ? 3 : undefined);

  it("turns the URL filters into the API query", () => {
    expect(
      peopleStatsParams(
        {
          period: "all",
          role: "contact",
          topic: "dns,backup",
          tag: "fast",
          team: "Platform",
          label: "homelab",
          project: "home-lab",
          sort: "speed",
        },
        "2026-11-12",
        ids,
      ),
    ).toEqual({
      role: "contact",
      topic: ["dns", "backup"],
      tag: ["fast"],
      team: "Platform",
      label: ["homelab"],
      projectId: 3,
      sort: "speed",
      limit: 500,
    });
  });

  it("waits for the project list before asking for a project", () => {
    expect(peopleStatsParams({ project: "unknown" }, "2026-11-12", ids)).toBeUndefined();
    expect(peopleStatsParams({ project: "inbox" }, "2026-11-12", ids)?.projectId).toBe("inbox");
  });
});

describe("barParts", () => {
  it("scales open and done to the biggest total in the list", () => {
    expect(barParts({ total: 10, open: 3, done: 5 }, 20)).toEqual({ open: 15, done: 25 });
    expect(barParts({ total: 0, open: 0, done: 0 }, 0)).toEqual({ open: 0, done: 0 });
  });
});
