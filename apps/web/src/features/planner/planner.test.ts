import type { TimeBlock } from "@organizer/shared";
import { describe, expect, it } from "vitest";
import { makeOccurrence, makeSeries } from "../../test/meetings.ts";
import {
  blockColor,
  blockKey,
  blockSource,
  blockSpan,
  edgeScrollStep,
  lengthMinutes,
  minutesToTime,
  movedSpan,
  nextQuarter,
  blockItem,
  meetingItem,
  seriesMoveScopes,
  ONLY_THIS_DAY,
  placeItems,
  scrollStartMinutes,
  snap,
} from "./planner.ts";
import { plannedSharedText } from "./BlockDialog.tsx";

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
    space: null,
    member: null,
    assignee: null,
  };
}

/** Blocks only, as the planner had them before meetings. */
const place = (blocks: TimeBlock[], day: string, tz: string) => placeItems(blocks.map(blockItem), day, tz);

describe("placeItems", () => {
  it("places blocks by local minutes and puts overlaps side by side", () => {
    const blocks = [
      block(1, "2026-11-12T08:00:00.000Z", "2026-11-12T09:00:00.000Z"),
      block(2, "2026-11-12T08:30:00.000Z", "2026-11-12T09:30:00.000Z"),
      block(3, "2026-11-12T12:00:00.000Z", "2026-11-12T13:00:00.000Z"),
    ];
    const placed = place(blocks, "2026-11-12", TZ);
    expect(placed.map((p) => [p.item.key, p.startMin, p.endMin, p.lane, p.lanes])).toEqual([
      ["block-1", 540, 600, 0, 2],
      ["block-2", 570, 630, 1, 2],
      ["block-3", 780, 840, 0, 1],
    ]);
  });

  it("cuts a block that crosses midnight at the day's edges", () => {
    const night = block(4, "2026-11-12T22:30:00.000Z", "2026-11-13T00:30:00.000Z");
    const [first] = place([night], "2026-11-12", TZ);
    expect([first?.startMin, first?.endMin, first?.continuesAfter]).toEqual([1410, 1440, true]);
    const [second] = place([night], "2026-11-13", TZ);
    expect([second?.startMin, second?.endMin, second?.continuesBefore]).toEqual([0, 90, true]);
    expect(place([night], "2026-11-14", TZ)).toEqual([]);
  });
});

describe("placeItems on whole and odd length days", () => {
  it("places a block from 00:00 to 24:00 as the whole day, continuing nowhere", () => {
    const whole = block(5, "2026-11-11T23:00:00.000Z", "2026-11-12T23:00:00.000Z");
    const [p] = place([whole], "2026-11-12", TZ);
    expect([p?.startMin, p?.endMin, p?.continuesBefore, p?.continuesAfter]).toEqual([0, 1440, false, false]);
    expect(place([whole], "2026-11-13", TZ)).toEqual([]);
    expect(place([whole], "2026-11-11", TZ)).toEqual([]);
  });

  it("ends a block that stops exactly at midnight on its own day only", () => {
    const evening = block(6, "2026-11-12T21:00:00.000Z", "2026-11-12T23:00:00.000Z");
    expect(place([evening], "2026-11-13", TZ)).toEqual([]);
    expect(place([evening], "2026-11-12", TZ)[0]?.continuesAfter).toBe(false);
  });

  it("counts a 23 hour day (clocks go forward) and a 25 hour day (clocks go back)", () => {
    const spring = block(7, "2026-03-28T23:00:00.000Z", "2026-03-29T22:00:00.000Z");
    expect(place([spring], "2026-03-29", TZ)[0]).toMatchObject({ startMin: 0, endMin: 23 * 60 });
    const autumn = block(8, "2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z");
    expect(place([autumn], "2026-10-25", TZ)[0]).toMatchObject({ startMin: 0, endMin: 25 * 60 });
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

  it("starts scrolling only inside the edge zone and treats the grid's side lines as inside", () => {
    expect(edgeScrollStep({ x: 400, y: 148 }, area)).toBe(0);
    expect(edgeScrollStep({ x: 400, y: 147 }, area)).toBeLessThan(0);
    expect(edgeScrollStep({ x: 50, y: 105 }, area)).toBeLessThan(0);
    expect(edgeScrollStep({ x: 850, y: 595 }, area)).toBeGreaterThan(0);
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

  it("handles a block on a 23 hour day and the 24:00 end on a clock change day", () => {
    expect(blockSpan("2026-03-29", "22:00", "24:00", TZ)).toEqual({
      startAt: "2026-03-29T20:00:00.000Z",
      endAt: "2026-03-29T22:00:00.000Z",
    });
    expect(blockSpan("2026-10-25", "00:00", "24:00", TZ).endAt).toBe("2026-10-25T23:00:00.000Z");
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

describe("meetings in the planner", () => {
  it("shares lanes between blocks and meeting dates, in start order", () => {
    const standup = makeOccurrence({
      occursOn: "2026-11-12",
      startAt: "2026-11-12T08:00:00.000Z",
      endAt: "2026-11-12T08:15:00.000Z",
    });
    const items = [
      blockItem(block(1, "2026-11-12T08:00:00.000Z", "2026-11-12T09:00:00.000Z")),
      meetingItem(standup),
      blockItem(block(2, "2026-11-12T12:00:00.000Z", "2026-11-12T13:00:00.000Z")),
    ];
    const placed = placeItems(items, "2026-11-12", TZ);
    // The longer block first at the same start, the meeting next to it; the later block alone.
    expect(placed.map((p) => [p.item.key, p.startMin, p.endMin, p.lane, p.lanes])).toEqual([
      ["block-1", 540, 600, 0, 2],
      ["meeting-7-2026-11-12", 540, 555, 1, 2],
      ["block-2", 780, 840, 0, 1],
    ]);
  });

  it("places a meeting date at the span of a pending move, keyed by its original date", () => {
    const standup = makeOccurrence({ occursOn: "2026-11-12", startAt: "2026-11-12T08:00:00.000Z" });
    const moved = meetingItem(standup, {
      startAt: "2026-11-13T09:00:00.000Z",
      endAt: "2026-11-13T09:15:00.000Z",
    });
    expect(placeItems([moved], "2026-11-12", TZ)).toEqual([]);
    const [p] = placeItems([moved], "2026-11-13", TZ);
    expect([p?.item.key, p?.startMin]).toEqual(["meeting-7-2026-11-12", 600]);
  });

  it("offers every scope for a move on the same day or to a day the weekly repeat can follow", () => {
    const thursdays = [makeSeries()];
    const thu = { seriesId: 1, occursOn: "2026-11-19" };
    // Same day, later: all three.
    expect(
      seriesMoveScopes(thursdays, thu, "2026-11-19T09:00:00.000Z", TZ).map((o) => o.off ?? null),
    ).toEqual([null, null, null]);
    // To Friday: the weekdays turn to Fri, so following and all work too.
    const friday = seriesMoveScopes(thursdays, thu, "2026-11-20T08:00:00.000Z", TZ);
    expect(friday.every((o) => !o.off)).toBe(true);
    expect(friday[1]?.hint).toBe("From 19.11. on");
  });

  it("offers only this date when the repeat cannot move by those days", () => {
    // Monthly on the 30th: no rule for every date one day later.
    const monthly = [makeSeries({ rule: { every: "month", interval: 1, monthDay: 30, basis: "schedule" } })];
    const choices = seriesMoveScopes(
      monthly,
      { seriesId: 1, occursOn: "2026-11-30" },
      "2026-12-01T08:00:00.000Z",
      TZ,
    );
    expect(choices.map((o) => [o.scope, o.off ?? null])).toEqual([
      ["this", null],
      ["following", ONLY_THIS_DAY],
      ["all", ONLY_THIS_DAY],
    ]);
  });

  it("says that All changes only this part of a split repeat", () => {
    const split = [makeSeries({ endsOn: "2026-11-25" }), makeSeries({ id: 2, startsOn: "2026-11-27" })];
    const choices = seriesMoveScopes(
      split,
      { seriesId: 2, occursOn: "2026-12-03" },
      "2026-12-03T09:00:00.000Z",
      TZ,
    );
    expect(choices[2]?.hint).toBe("Every date from 27.11. on, this part of the repeat");
  });
});

describe("blocks of shared projects (S5#13)", () => {
  const anna = { accountId: 1, username: "anna", name: "Anna" };
  const ana = { accountId: 2, username: "ana", name: "Ana Bell" };
  const space = { id: 7, name: "Home move", color: "#4C9AFF" };

  it("keys them apart from your own blocks with the same id", () => {
    const own = block(5, "2026-11-12T08:00:00.000Z", "2026-11-12T09:00:00.000Z");
    expect(blockKey(own)).toBe("block-5");
    expect(blockKey({ ...own, space })).toBe("block-s7-5");
  });

  it("says where a block comes from: the project in your tab, the member in the project's", () => {
    const own = block(5, "2026-11-12T08:00:00.000Z", "2026-11-12T09:00:00.000Z");
    expect(blockSource({ ...own, space, member: anna }, "anna")).toBe("Home move");
    expect(blockSource({ ...own, member: ana }, "anna")).toBe("Ana Bell");
    expect(blockSource({ ...own, member: anna }, "anna")).toBeUndefined();
    expect(blockSource(own, "anna")).toBeUndefined();
    expect(blockColor({ ...own, space })).toBe("#4C9AFF");
  });

  it("tells whether planning gave the todo to you or it stays someone else's", () => {
    expect(plannedSharedText("Book van", anna, "anna")).toBe("Planned Book van, assigned to you");
    expect(plannedSharedText("Book van", ana, "anna")).toBe(
      "Planned Book van; it stays assigned to Ana Bell",
    );
    expect(plannedSharedText("Book van", null, "anna")).toBe("Planned Book van");
  });
});
