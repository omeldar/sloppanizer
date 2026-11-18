import { describe, expect, it } from "vitest";
import {
  CreateMeeting,
  MarkInput,
  OccurrenceChange,
  OccurrenceQuery,
  ScheduleChange,
  SeriesInput,
  StandupFilter,
  StandupQuery,
  suggestMeetingType,
  UpdateMeeting,
} from "./meetings.ts";

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

const schedule = {
  rule: { every: "week", weekdays: ["thu"] },
  startsOn: "2026-11-19",
  startTime: "09:00",
  durationMinutes: 15,
};

const mark = (todoId: number) => ({ todoId, kind: "said", coveredUntil: "2026-11-19T08:00:00.000Z" });

describe("meetings contract", () => {
  it("suggests a standup for standup, daily and scrum names", () => {
    expect(["Weekly Standup", "stand-up", "Daily sync", "Scrum of scrums"].map(suggestMeetingType)).toEqual([
      "standup",
      "standup",
      "standup",
      "standup",
    ]);
    expect(suggestMeetingType("Retro")).toBe("other");
  });

  it("takes a schedule rule with a time and a length, never one counted from done", () => {
    expect(CreateMeeting.parse({ name: " Standup ", schedule })).toMatchObject({
      name: "Standup",
      schedule: { rule: { every: "week", interval: 1, basis: "schedule" } },
    });
    expect(ok(SeriesInput, { ...schedule, rule: { every: "day", basis: "done" } })).toBe(false);
    expect(ok(SeriesInput, { ...schedule, startTime: "9:00" })).toBe(false);
    expect(ok(SeriesInput, { ...schedule, durationMinutes: 4 })).toBe(false);
    expect(ok(SeriesInput, { ...schedule, durationMinutes: 1441 })).toBe(false);
    expect(ok(SeriesInput, { ...schedule, endsOn: "2026-11-18" })).toBe(false);
    expect(ok(SeriesInput, { ...schedule, endsOn: "2026-11-19" })).toBe(true);
    expect(ok(SeriesInput, { ...schedule, endsOn: "2036-11-19" })).toBe(true);
    expect(ok(SeriesInput, { ...schedule, endsOn: "2037-11-19" })).toBe(false);
    expect(ok(SeriesInput, { ...schedule, startsOn: "2000-01-01", endsOn: "9999-12-31" })).toBe(false);
    expect(ok(SeriesInput, { ...schedule, startsOn: "3000-01-01" })).toBe(false);
    expect(ok(CreateMeeting, { name: "", schedule })).toBe(false);
  });

  it("fills the filter with everything and drops repeated ids", () => {
    expect(StandupFilter.parse({})).toEqual({ projectIds: [], inbox: false, labelIds: [] });
    expect(StandupFilter.parse({ projectIds: [2, 2, 3] }).projectIds).toEqual([2, 3]);
    expect(ok(StandupFilter, { projectIds: Array.from({ length: 51 }, (_, i) => i + 1) })).toBe(false);
    expect(ok(UpdateMeeting, {})).toBe(false);
    expect(ok(UpdateMeeting, { countFrom: "2026-11-12" })).toBe(true);
  });

  it("tells moves, cancels and undo of a date apart", () => {
    const move = { startAt: "2026-11-19T10:00:00+01:00", endAt: "2026-11-19T10:15:00+01:00" };
    expect(OccurrenceChange.parse({ scope: "all", ...move })).toEqual({
      scope: "all",
      startAt: "2026-11-19T09:00:00.000Z",
      endAt: "2026-11-19T09:15:00.000Z",
    });
    expect(ok(OccurrenceChange, { scope: "this", ...move, endAt: "2026-11-19T10:04:00+01:00" })).toBe(false);
    expect(ok(OccurrenceChange, { scope: "following", cancelled: true })).toBe(true);
    // Cancelling all is deleting the meeting; undo is for a single date.
    expect(ok(OccurrenceChange, { scope: "all", cancelled: true })).toBe(false);
    expect(ok(OccurrenceChange, { scope: "following", cancelled: false })).toBe(false);
    expect(ok(OccurrenceChange, { scope: "this", cancelled: false })).toBe(true);
    expect(ok(OccurrenceChange, { scope: "this", cancelled: true, ...move })).toBe(false);
  });

  it("needs a change in a schedule change", () => {
    expect(ok(ScheduleChange, { scope: "following", from: "2026-11-19" })).toBe(false);
    expect(ok(ScheduleChange, { scope: "this", from: "2026-11-19", startTime: "10:00" })).toBe(false);
    expect(ok(ScheduleChange, { scope: "all", from: "2026-11-19", endsOn: null })).toBe(true);
  });

  it("marks each todo once, 1 to 200 at a time", () => {
    expect(ok(MarkInput, { on: "2026-11-19", marks: [mark(1), mark(2)] })).toBe(true);
    expect(ok(MarkInput, { on: "2026-11-19", marks: [mark(1), mark(1)] })).toBe(false);
    expect(ok(MarkInput, { on: "2026-11-19", marks: [] })).toBe(false);
    expect(ok(MarkInput, { on: "2026-11-19", marks: [{ ...mark(1), kind: "held" }] })).toBe(false);
  });

  it("reads queries from the query string", () => {
    expect(StandupQuery.parse({ kind: "done,blocked" })).toEqual({ kind: ["done", "blocked"] });
    expect(ok(StandupQuery, { kind: "done,later" })).toBe(false);
    expect(OccurrenceQuery.parse({ from: "2026-11-01", to: "2026-11-30", cancelled: "true" })).toMatchObject({
      cancelled: true,
    });
    expect(ok(OccurrenceQuery, { from: "2026-11-01", to: "2027-01-03" })).toBe(false);
    expect(ok(OccurrenceQuery, { from: "2026-11-02", to: "2026-11-01" })).toBe(false);
  });
});
