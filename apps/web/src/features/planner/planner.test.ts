import type { TimeBlock } from "@organizer/shared";
import { describe, expect, it } from "vitest";
import {
  blockSpan,
  edgeScrollStep,
  lengthMinutes,
  minutesToTime,
  movedSpan,
  nextQuarter,
  placeBlocks,
  scrollStartMinutes,
  snap,
} from "./planner.ts";

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
});

describe("scrollStartMinutes", () => {
  it("opens an hour before now on the week with today", () => {
    expect(scrollStartMinutes(true, 14 * 60 + 20)).toBe(13 * 60 + 20);
  });

  it("never opens before midnight in the first hour of the day", () => {
    expect(scrollStartMinutes(true, 25)).toBe(0);
  });

  it("opens at 07:00 on a week without today, whatever the time", () => {
    expect(scrollStartMinutes(false, 25)).toBe(7 * 60);
    expect(scrollStartMinutes(false, 23 * 60)).toBe(7 * 60);
  });
});

describe("edgeScrollStep", () => {
  const area = { top: 100, bottom: 600, left: 50, right: 850 };

  it("leaves the grid alone while the pointer is away from its edges", () => {
    expect(edgeScrollStep({ x: 400, y: 350 }, area)).toBe(0);
    expect(edgeScrollStep({ x: 400, y: 148 }, area)).toBe(0);
    expect(edgeScrollStep({ x: 400, y: 552 }, area)).toBe(0);
  });

  it("scrolls up near the top and down near the bottom, faster closer to the edge", () => {
    const slowUp = edgeScrollStep({ x: 400, y: 140 }, area);
    const fastUp = edgeScrollStep({ x: 400, y: 105 }, area);
    expect(slowUp).toBeLessThan(0);
    expect(fastUp).toBeLessThan(slowUp);
    const slowDown = edgeScrollStep({ x: 400, y: 560 }, area);
    const fastDown = edgeScrollStep({ x: 400, y: 595 }, area);
    expect(slowDown).toBeGreaterThan(0);
    expect(fastDown).toBeGreaterThan(slowDown);
  });

  it("keeps full speed past the edge (over the day heads or below the grid)", () => {
    expect(edgeScrollStep({ x: 400, y: 20 }, area)).toBe(-16);
    expect(edgeScrollStep({ x: 400, y: 900 }, area)).toBe(16);
  });

  it("does not scroll while the pointer is beside the grid (over the To plan list)", () => {
    expect(edgeScrollStep({ x: 900, y: 595 }, area)).toBe(0);
    expect(edgeScrollStep({ x: 10, y: 105 }, area)).toBe(0);
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

  it("measures a block's length, past midnight too", () => {
    expect(lengthMinutes("09:00", "10:30")).toBe(90);
    expect(lengthMinutes("23:00", "00:00")).toBe(60);
    expect(lengthMinutes("23:00", "02:00")).toBe(180);
    expect(lengthMinutes("23:00", "24:00")).toBe(60);
    expect(lengthMinutes("08:00", "08:00")).toBe(24 * 60);
  });

  it("starts a new block at the next quarter hour", () => {
    expect(nextQuarter(new Date("2026-11-12T08:07:00.000Z"), TZ)).toBe("09:15");
    expect(nextQuarter(new Date("2026-11-12T08:15:00.000Z"), TZ)).toBe("09:30");
  });
});

describe("movedSpan", () => {
  const b = { startAt: "2026-11-12T08:00:00.000Z", endAt: "2026-11-12T09:30:00.000Z" };
  it("moves by minutes and days and keeps the length", () => {
    expect(movedSpan(b, 45, 0, "move", TZ)).toEqual({
      startAt: "2026-11-12T08:45:00.000Z",
      endAt: "2026-11-12T10:15:00.000Z",
    });
    expect(movedSpan(b, 0, 2, "move", TZ).startAt).toBe("2026-11-14T08:00:00.000Z");
  });
  it("resizes the end, never below 15 minutes", () => {
    expect(movedSpan(b, 30, 0, "resize", TZ).endAt).toBe("2026-11-12T10:00:00.000Z");
    expect(movedSpan(b, -120, 0, "resize", TZ).endAt).toBe("2026-11-12T08:15:00.000Z");
  });
});
