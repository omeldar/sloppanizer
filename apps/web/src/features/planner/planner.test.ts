import type { TimeBlock } from "@organizer/shared";
import { describe, expect, it } from "vitest";
import { blockSpan, minutesToTime, nextQuarter, placeBlocks, snap, visibleHours } from "./planner.ts";

const TZ = "Europe/Zurich";

function block(id: number, startAt: string, endAt: string): TimeBlock {
  return {
    id,
    todoId: null,
    title: `Block ${id}`,
    startAt,
    endAt,
    todo: null,
    project: null,
    createdBy: "you",
    createdAt: startAt,
    updatedAt: startAt,
  };
}

describe("placeBlocks", () => {
  it("places blocks by local minutes and puts overlaps side by side", () => {
    const blocks = [
      block(1, "2026-11-12T08:00:00.000Z", "2026-11-12T09:00:00.000Z"),
      block(2, "2026-11-12T08:30:00.000Z", "2026-11-12T09:30:00.000Z"),
      block(3, "2026-11-12T12:00:00.000Z", "2026-11-12T13:00:00.000Z"),
    ];
    const placed = placeBlocks(blocks, "2026-11-12", TZ);
    expect(placed.map((p) => [p.block.id, p.startMin, p.endMin, p.lane, p.lanes])).toEqual([
      [1, 540, 600, 0, 2],
      [2, 570, 630, 1, 2],
      [3, 780, 840, 0, 1],
    ]);
  });

  it("cuts a block that crosses midnight at the day's edges", () => {
    const night = block(4, "2026-11-12T22:30:00.000Z", "2026-11-13T00:30:00.000Z");
    const [first] = placeBlocks([night], "2026-11-12", TZ);
    expect([first?.startMin, first?.endMin, first?.continuesAfter]).toEqual([1410, 1440, true]);
    const [second] = placeBlocks([night], "2026-11-13", TZ);
    expect([second?.startMin, second?.endMin, second?.continuesBefore]).toEqual([0, 90, true]);
    expect(placeBlocks([night], "2026-11-14", TZ)).toEqual([]);
  });

  it("widens the visible hours to every block", () => {
    const early = placeBlocks(
      [block(5, "2026-11-12T04:00:00.000Z", "2026-11-12T05:00:00.000Z")],
      "2026-11-12",
      TZ,
    );
    expect(visibleHours(early)).toEqual({ first: 5, last: 22 });
    expect(visibleHours([])).toEqual({ first: 7, last: 22 });
  });
});

describe("time helpers", () => {
  it("snaps to quarter hours and prints minutes", () => {
    expect([snap(52), snap(53), snap(0)]).toEqual([45, 60, 0]);
    expect([minutesToTime(570), minutesToTime(1440)]).toEqual(["09:30", "24:00"]);
  });

  it("turns a local day and times into a span, an early end into the next day", () => {
    expect(blockSpan("2026-11-12", "09:00", "10:30", TZ)).toEqual({
      startAt: "2026-11-12T08:00:00.000Z",
      endAt: "2026-11-12T09:30:00.000Z",
    });
    expect(blockSpan("2026-11-12", "23:00", "01:00", TZ).endAt).toBe("2026-11-13T00:00:00.000Z");
    expect(blockSpan("2026-11-12", "22:00", "24:00", TZ).endAt).toBe("2026-11-12T23:00:00.000Z");
  });

  it("starts a new block at the next quarter hour", () => {
    expect(nextQuarter(new Date("2026-11-12T08:07:00.000Z"), TZ)).toBe("09:15");
    expect(nextQuarter(new Date("2026-11-12T08:15:00.000Z"), TZ)).toBe("09:30");
  });
});
