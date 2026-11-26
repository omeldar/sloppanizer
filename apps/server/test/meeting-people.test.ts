import type { Meeting, MeetingOccurrence, Person, WorkStats } from "@organizer/shared";
import { describe, expect, it } from "vitest";
import { json, makeApp, type TestApp } from "./helpers.ts";

// The test clock starts on Wednesday 11.11.2026 at 11:00 in Zurich (10:00 UTC).

/** A one-time meeting: a schedule without a rule. */
const once = (t: TestApp, more: Record<string, unknown> = {}, schedule: Record<string, unknown> = {}) =>
  t.create<Meeting>("/api/v1/meetings", {
    name: "Kick-off with Acme",
    schedule: { startsOn: "2026-11-13", startTime: "14:00", durationMinutes: 60, ...schedule },
    ...more,
  });

const occurrences = async (t: TestApp, query = "from=2026-11-09&to=2026-12-13") =>
  json<MeetingOccurrence[]>(await t.call("GET", `/api/v1/meetings/occurrences?${query}`));

const names = (meeting: Meeting) => meeting.people.map((p) => p.displayName);

describe("one-time meetings", () => {
  it("plans a meeting on one date when the schedule has no rule", async () => {
    const t = await makeApp();
    const meeting = await once(t);
    expect(meeting).toMatchObject({
      name: "Kick-off with Acme",
      type: "other",
      oneTime: true,
      schedule: { startsOn: "2026-11-13", endsOn: "2026-11-13", startTime: "14:00", durationMinutes: 60 },
      next: { occursOn: "2026-11-13", startAt: "2026-11-13T13:00:00.000Z", oneTime: true },
    });
    expect(meeting.segments).toHaveLength(1);
    expect(meeting.schedule.text).toBe("once on 13.11.2026, 14:00–15:00");
    expect((await occurrences(t)).map((o) => [o.occursOn, o.startAt, o.oneTime])).toEqual([
      ["2026-11-13", "2026-11-13T13:00:00.000Z", true],
    ]);
    // An end date that is the same day is fine; another one is a repeat, which needs a rule.
    expect((await once(t, { name: "Same day" }, { endsOn: "2026-11-13" })).oneTime).toBe(true);
    const refused = await t.call("POST", "/api/v1/meetings", {
      name: "Two days",
      schedule: { startsOn: "2026-11-13", endsOn: "2026-11-14", startTime: "14:00", durationMinutes: 60 },
    });
    expect(refused.statusCode).toBe(422);
  });

  it("keeps repeating meetings as they were and moves a one-time meeting's only date", async () => {
    const t = await makeApp();
    const weekly = await t.create<Meeting>("/api/v1/meetings", {
      name: "Weekly Standup",
      schedule: { rule: { every: "week" }, startsOn: "2026-11-12", startTime: "09:00", durationMinutes: 15 },
    });
    expect(weekly.oneTime).toBe(false);
    const meeting = await once(t);
    const moved = await t.call("PATCH", `/api/v1/meetings/${meeting.id}/occurrences/2026-11-13`, {
      scope: "this",
      startAt: "2026-11-16T09:00:00.000Z",
      endAt: "2026-11-16T09:30:00.000Z",
    });
    expect(moved.statusCode).toBe(200);
    const list = (await occurrences(t)).filter((o) => o.meetingId === meeting.id);
    expect(list.map((o) => [o.occursOn, o.startAt, o.status])).toEqual([
      ["2026-11-13", "2026-11-16T09:00:00.000Z", "moved"],
    ]);
  });
});

describe("people in meetings", () => {
  it("adds people by id or name, changes and replaces them", async () => {
    const t = await makeApp();
    const bo = await t.create<Person>("/api/v1/people", { firstName: "Bo", lastName: "Berg" });
    const meeting = await once(t, {
      people: [{ personId: bo.id }, { firstName: "Anna", lastName: "Meier" }, { personId: bo.id }],
    });
    expect(names(meeting)).toEqual(["Anna Meier", "Bo Berg"]);
    const anna = meeting.people.find((p) => p.firstName === "Anna");
    // The name made a new person in the directory.
    expect(json<Person[]>(await t.call("GET", "/api/v1/people")).map((p) => p.displayName)).toContain(
      "Anna Meier",
    );

    const patch = (body: unknown) => t.call("PATCH", `/api/v1/meetings/${meeting.id}`, body);
    expect(
      names(
        json<Meeting>(
          await patch({
            addPeople: [{ firstName: "Cleo", lastName: "Chan" }],
            removePeople: [{ personId: bo.id }],
          }),
        ),
      ),
    ).toEqual(["Anna Meier", "Cleo Chan"]);
    // Removing a name that is not in the directory changes nothing and creates nobody.
    expect(
      names(json<Meeting>(await patch({ removePeople: [{ firstName: "Nobody", lastName: "Here" }] }))),
    ).toEqual(["Anna Meier", "Cleo Chan"]);
    expect(names(json<Meeting>(await patch({ people: [{ personId: bo.id }] })))).toEqual(["Bo Berg"]);
    expect(names(json<Meeting>(await patch({ people: [] })))).toEqual([]);
    expect(
      (await patch({ people: [{ personId: bo.id }], addPeople: [{ personId: bo.id }] })).statusCode,
    ).toBe(422);
    expect((await patch({ people: [{ personId: 999 }] })).statusCode).toBe(422);

    // Deleting a person takes them out of the meeting.
    await patch({ people: [{ personId: bo.id }, { personId: anna?.id }] });
    expect((await t.call("DELETE", `/api/v1/people/${bo.id}`)).statusCode).toBe(204);
    expect(names(json<Meeting>(await t.call("GET", `/api/v1/meetings/${meeting.id}`)))).toEqual([
      "Anna Meier",
    ]);
  });

  it("refuses more than 50 people in one meeting", async () => {
    const t = await makeApp();
    const people = Array.from({ length: 51 }, (_, i) => ({ firstName: "Person", lastName: `N${i}` }));
    expect(
      (
        await t.call("POST", "/api/v1/meetings", {
          name: "All hands",
          schedule: { startsOn: "2026-11-13", startTime: "14:00", durationMinutes: 60 },
          people,
        })
      ).statusCode,
    ).toBe(422);
    const meeting = await once(t, { people: people.slice(0, 50) });
    const more = await t.call("PATCH", `/api/v1/meetings/${meeting.id}`, {
      addPeople: [{ firstName: "One", lastName: "More" }],
    });
    expect(more.statusCode).toBe(422);
  });
});

describe("time in meetings in Statistics", () => {
  it("counts one-time meetings and the time per person", async () => {
    const t = await makeApp();
    const anna = { firstName: "Anna", lastName: "Meier" };
    // Monday 09.11: a one-time hour with Anna and Bo; Tuesday 10.11: a one-time half hour with Anna.
    await once(
      t,
      { name: "Kick-off", people: [anna, { firstName: "Bo", lastName: "Berg" }] },
      {
        startsOn: "2026-11-09",
        startTime: "13:00",
      },
    );
    await once(
      t,
      { name: "Review", people: [anna] },
      { startsOn: "2026-11-10", startTime: "08:00", durationMinutes: 30 },
    );
    // A weekly 15 minute standup without people, on Mondays and Wednesdays (today's is over at 09:15).
    await t.create("/api/v1/meetings", {
      name: "Standup",
      schedule: {
        rule: { every: "week", weekdays: ["mon", "wed"] },
        startsOn: "2026-11-09",
        startTime: "09:00",
        durationMinutes: 15,
      },
    });
    // Friday 13.11 is still to come, so it does not count yet.
    await once(t, { name: "Later", people: [anna] }, { startsOn: "2026-11-13" });

    const s = json<WorkStats>(await t.call("GET", "/api/v1/stats/overview?from=2026-11-09&to=2026-11-15"));
    expect(s.totals.meetingMinutes).toBe(60 + 30 + 15 + 15);
    expect(s.meetingPeople.map((p) => [p.person.name, p.minutes, p.dates])).toEqual([
      ["Anna Meier", 90, 2],
      ["Bo Berg", 60, 1],
    ]);
    expect(s.meetingMinutesWithoutPeople).toBe(30);
  });
});
