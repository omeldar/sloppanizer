import { describe, expect, it } from "vitest";
import { makeItem, makeSeries, makeStandup } from "../test/meetings.ts";
import { defaultMeetingDate, segmentOf, stepMeetingDate, withMark } from "./meetings.ts";

const thursdays = [makeSeries()];

describe("stepping through a meeting's dates", () => {
  it("goes to the next and previous Thursday and stops at the first date", () => {
    expect(stepMeetingDate(thursdays, "2026-11-19", 1)).toBe("2026-11-26");
    expect(stepMeetingDate(thursdays, "2026-11-19", -1)).toBe("2026-11-12");
    // A day between two dates steps to the dates around it.
    expect(stepMeetingDate(thursdays, "2026-11-21", -1)).toBe("2026-11-19");
    expect(stepMeetingDate(thursdays, "2026-11-05", -1)).toBeNull();
  });

  it("crosses from one part of a split repeat into the next one", () => {
    // Thursdays until 19.11., then Fridays from 27.11. on.
    const split = [
      makeSeries({ endsOn: "2026-11-25" }),
      makeSeries({ id: 2, startsOn: "2026-11-27", rule: { ...thursdays[0]!.rule, weekdays: ["fri"] } }),
    ];
    expect(stepMeetingDate(split, "2026-11-19", 1)).toBe("2026-11-27");
    expect(stepMeetingDate(split, "2026-11-27", -1)).toBe("2026-11-19");
    expect(segmentOf(split, "2026-12-04")?.id).toBe(2);
    expect(segmentOf(split, "2026-11-26")).toBeUndefined();
  });

  it("opens on today's date, else the next one, else the last one of an ended repeat", () => {
    expect(defaultMeetingDate(thursdays, "2026-11-19")).toBe("2026-11-19");
    expect(defaultMeetingDate(thursdays, "2026-11-20")).toBe("2026-11-26");
    const ended = [makeSeries({ endsOn: "2026-11-12" })];
    expect(defaultMeetingDate(ended, "2026-11-20")).toBe("2026-11-12");
  });
});

describe("a mark shown before the server answers", () => {
  const list = makeStandup([makeItem("done", 1, "Ship the release"), makeItem("blocked", 2, "Fix the VPN")]);

  it("moves a said item to the top of the said list and counts its kind down", () => {
    const next = withMark(list, { todoId: 2, kind: "said" }, "2026-11-19T08:05:00.000Z");
    expect(next.items.map((i) => i.todo.id)).toEqual([1]);
    expect(next.counts).toEqual({ done: 1, started: 0, updated: 0, blocked: 0 });
    expect(next.said[0]).toEqual({
      todo: list.items[1]?.todo,
      project: null,
      markedAt: "2026-11-19T08:05:00.000Z",
    });
    expect(next.dismissedCount).toBe(0);
  });

  it("counts a dismissed item as dismissed, not as said", () => {
    const next = withMark(list, { todoId: 1, kind: "dismissed" }, "2026-11-19T08:05:00.000Z");
    expect(next.items.map((i) => i.todo.id)).toEqual([2]);
    expect(next.said).toEqual([]);
    expect(next.dismissedCount).toBe(1);
    expect(next.counts.done).toBe(0);
  });

  it("leaves a list alone that does not show the todo", () => {
    const next = withMark(list, { todoId: 99, kind: "said" }, "2026-11-19T08:05:00.000Z");
    expect(next.items).toEqual(list.items);
    expect(next.counts).toEqual(list.counts);
    expect(next.said).toEqual([]);
  });
});
