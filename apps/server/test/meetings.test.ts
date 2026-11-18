import { addDays, type Meeting, type MeetingOccurrence, type Project } from "@organizer/shared";
import { describe, expect, it } from "vitest";
import { json, makeApp, type TestApp } from "./helpers.ts";

// The test clock starts on Wednesday 11.11.2026 at 11:00 in Zurich (10:00 UTC).

const weekly = (weekdays: string[] = ["thu"]) => ({ every: "week", weekdays });

const SCHEDULE = { rule: weekly(), startsOn: "2026-11-12", startTime: "09:00", durationMinutes: 15 };

/** "Weekly Standup", Thursdays 09:00 to 09:15 from 12.11.2026. */
const standup = (t: TestApp, more: Record<string, unknown> = {}) =>
  t.create<Meeting>("/api/v1/meetings", {
    name: "Weekly Standup",
    schedule: { rule: weekly(), startsOn: "2026-11-12", startTime: "09:00", durationMinutes: 15 },
    ...more,
  });

const occurrences = async (t: TestApp, query = "from=2026-11-09&to=2026-12-13") =>
  json<MeetingOccurrence[]>(await t.call("GET", `/api/v1/meetings/occurrences?${query}`)).map(
    (o) => `${o.occursOn} ${o.startAt.slice(5, 16)} ${o.status}`,
  );

const change = (t: TestApp, id: number, on: string, body: unknown) =>
  t.call("PATCH", `/api/v1/meetings/${id}/occurrences/${on}`, body);

const segments = (meeting: Meeting) =>
  meeting.segments.map((s) => `${s.startsOn}..${s.endsOn ?? ""} ${s.text}`);

describe("meetings", () => {
  it("creates a standup that counts from the last meeting date and knows its next date", async () => {
    const t = await makeApp();
    const meeting = await standup(t);
    expect(meeting).toMatchObject({
      name: "Weekly Standup",
      type: "standup",
      filter: { projectIds: [], inbox: false, labelIds: [] },
      // The repeat starts tomorrow, so the window starts at the Thursday before, 09:00 in Zurich.
      since: "2026-11-05T08:00:00.000Z",
      schedule: { startsOn: "2026-11-12", endsOn: null, startTime: "09:00", durationMinutes: 15 },
      next: {
        occursOn: "2026-11-12",
        startAt: "2026-11-12T08:00:00.000Z",
        status: "scheduled",
        noteId: null,
      },
      openCount: 0,
    });
    expect(meeting.schedule.text).toBe("every week on Thu, 09:00–09:15");
    expect(json<Meeting[]>(await t.call("GET", "/api/v1/meetings")).map((m) => m.id)).toEqual([meeting.id]);
    expect(json<Meeting>(await t.call("GET", `/api/v1/meetings/${meeting.id}`)).name).toBe("Weekly Standup");
  });

  it("suggests the type from the name, takes an explicit type and a count-from day", async () => {
    const t = await makeApp();
    const retro = await standup(t, { name: "Retro" });
    expect(retro.type).toBe("other");
    const forced = await standup(t, { name: "Daily", type: "other", countFrom: "2026-11-09" });
    expect(forced).toMatchObject({ type: "other", since: "2026-11-08T23:00:00.000Z" });
    const res = await t.call("PATCH", `/api/v1/meetings/${retro.id}`, {
      type: "standup",
      countFrom: "2026-11-10",
      name: "Retro and standup",
    });
    expect(json<Meeting>(res)).toMatchObject({
      type: "standup",
      since: "2026-11-09T23:00:00.000Z",
      name: "Retro and standup",
    });
  });

  it("lists the meetings with the next one first", async () => {
    const t = await makeApp();
    const later = await standup(t, {
      name: "Monthly",
      schedule: { rule: { every: "month" }, startsOn: "2026-12-01", startTime: "10:00", durationMinutes: 60 },
    });
    const sooner = await standup(t);
    const ended = await standup(t, {
      name: "Old",
      schedule: {
        rule: weekly(["mon"]),
        startsOn: "2026-10-05",
        endsOn: "2026-10-19",
        startTime: "10:00",
        durationMinutes: 30,
      },
    });
    expect(ended.next).toBeNull();
    expect(ended.schedule.startsOn).toBe("2026-10-05");
    expect(json<Meeting[]>(await t.call("GET", "/api/v1/meetings")).map((m) => m.id)).toEqual([
      sooner.id,
      later.id,
      ended.id,
    ]);
  });

  it("refuses repeats without dates, ending before they start or counted from done", async () => {
    const t = await makeApp();
    const post = (schedule: Record<string, unknown>) =>
      t.call("POST", "/api/v1/meetings", {
        name: "Sync",
        schedule: { rule: weekly(), startTime: "09:00", durationMinutes: 15, ...schedule },
      });
    const noDates = await post({ startsOn: "2026-11-16", endsOn: "2026-11-18" });
    expect(noDates.statusCode).toBe(422);
    expect(noDates.json().error.message).toMatch(/no date from 16.11.2026 to 18.11.2026/);
    expect((await post({ startsOn: "2026-11-16", endsOn: "2026-11-15" })).statusCode).toBe(422);
    expect((await post({ startsOn: "2026-11-16", rule: { every: "day", basis: "done" } })).statusCode).toBe(
      422,
    );
    // until in the rule becomes the last date.
    const until = await post({ startsOn: "2026-11-12", rule: { ...weekly(), until: "2026-11-26" } });
    expect(json<Meeting>(until).schedule).toMatchObject({ endsOn: "2026-11-26", rule: { every: "week" } });
    expect(json<Meeting>(until).schedule.rule).not.toHaveProperty("until");
  });

  it("answers a huge repeat at once with a 422, also when it comes from a later change", async () => {
    const t = await makeApp();
    const started = performance.now();
    const huge = await t.call("POST", "/api/v1/meetings", {
      name: "Daily",
      schedule: {
        rule: { every: "day" },
        startsOn: "2000-01-01",
        endsOn: "9999-12-31",
        startTime: "09:00",
        durationMinutes: 15,
      },
    });
    expect(huge.statusCode).toBe(422);
    const { id } = await standup(t);
    const far = await t.call("PATCH", `/api/v1/meetings/${id}/schedule`, {
      scope: "all",
      from: "2026-11-12",
      endsOn: "2999-12-31",
    });
    expect(far.statusCode).toBe(422);
    expect(far.json().error.message).toMatch(/at most 10 years/);
    // Moving every date into the year 3000 is refused too.
    const moved = await change(t, id, "2026-11-12", {
      scope: "all",
      startAt: "3000-01-02T08:00:00.000Z",
      endAt: "3000-01-02T08:15:00.000Z",
    });
    expect(moved.statusCode).toBe(422);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(json<Meeting>(await t.call("GET", `/api/v1/meetings/${id}`)).segments).toHaveLength(1);
  });

  it("checks every project and label of the filter", async () => {
    const t = await makeApp();
    const project = await t.create<Project>("/api/v1/projects", { name: "Lab" });
    const label = await t.create<{ id: number }>("/api/v1/labels", { name: "ops" });
    const meeting = await standup(t, {
      filter: { projectIds: [project.id], inbox: true, labelIds: [label.id] },
    });
    expect(meeting.filter).toEqual({ projectIds: [project.id], inbox: true, labelIds: [label.id] });
    const unknown = await t.call("PATCH", `/api/v1/meetings/${meeting.id}`, { filter: { projectIds: [99] } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.message).toBe("Project 99 does not exist. Check the id.");
    expect(
      (await t.call("PATCH", `/api/v1/meetings/${meeting.id}`, { filter: { labelIds: [99] } })).statusCode,
    ).toBe(404);
  });

  it("expands the dates in the account's zone, also across the change to winter time", async () => {
    const t = await makeApp({ now: "2026-10-14T10:00:00.000Z" });
    await t.create("/api/v1/meetings", {
      name: "Standup",
      schedule: { rule: weekly(), startsOn: "2026-10-15", startTime: "09:00", durationMinutes: 15 },
    });
    expect(await occurrences(t, "from=2026-10-19&to=2026-11-01")).toEqual([
      "2026-10-22 10-22T07:00 scheduled",
      "2026-10-29 10-29T08:00 scheduled",
    ]);
    expect(
      (await t.call("GET", "/api/v1/meetings/occurrences?from=2026-10-01&to=2026-12-31")).statusCode,
    ).toBe(422);
    expect(
      (await t.call("GET", "/api/v1/meetings/occurrences?from=2026-10-01&to=2026-10-02&meetingId=9"))
        .statusCode,
    ).toBe(404);
  });

  it("deletes a meeting with its dates", async () => {
    const t = await makeApp();
    const meeting = await standup(t);
    expect((await t.call("DELETE", `/api/v1/meetings/${meeting.id}`)).statusCode).toBe(204);
    expect((await t.call("GET", `/api/v1/meetings/${meeting.id}`)).statusCode).toBe(404);
    expect(await occurrences(t)).toEqual([]);
    expect((await t.call("DELETE", `/api/v1/meetings/${meeting.id}`)).statusCode).toBe(404);
  });
});

describe("single date changes", () => {
  it("moves one date and back, cancels and restores it", async () => {
    const t = await makeApp();
    const { id } = await standup(t);
    const moved = await change(t, id, "2026-11-19", {
      scope: "this",
      startAt: "2026-11-18T14:00:00+01:00",
      endAt: "2026-11-18T14:30:00+01:00",
    });
    expect(moved.statusCode).toBe(200);
    expect(await occurrences(t, "from=2026-11-16&to=2026-11-22")).toEqual(["2026-11-19 11-18T13:00 moved"]);
    // Moving it back to its planned time removes the change.
    await change(t, id, "2026-11-19", {
      scope: "this",
      startAt: "2026-11-19T08:00:00.000Z",
      endAt: "2026-11-19T08:15:00.000Z",
    });
    expect(await occurrences(t, "from=2026-11-16&to=2026-11-22")).toEqual([
      "2026-11-19 11-19T08:00 scheduled",
    ]);

    await change(t, id, "2026-11-26", { scope: "this", cancelled: true });
    expect(await occurrences(t, "from=2026-11-23&to=2026-11-29")).toEqual([]);
    expect(await occurrences(t, "from=2026-11-23&to=2026-11-29&cancelled=true")).toEqual([
      "2026-11-26 11-26T08:00 cancelled",
    ]);
    // The next date skips the cancelled one.
    t.setNow("2026-11-20T10:00:00.000Z");
    expect(json<Meeting>(await t.call("GET", `/api/v1/meetings/${id}`)).next?.occursOn).toBe("2026-12-03");
    await change(t, id, "2026-11-26", { scope: "this", cancelled: false });
    expect(await occurrences(t, "from=2026-11-23&to=2026-11-29")).toEqual([
      "2026-11-26 11-26T08:00 scheduled",
    ]);
  });

  it("answers 404 for a date the meeting does not have", async () => {
    const t = await makeApp();
    const { id } = await standup(t);
    const res = await change(t, id, "2026-11-18", { scope: "this", cancelled: true });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe(`Meeting ${id} has no date on 18.11.2026.`);
    expect((await change(t, id, "2026-11-05", { scope: "this", cancelled: true })).statusCode).toBe(404);
  });

  it("moves this and following to another day: a new part from there, earlier dates stay", async () => {
    const t = await makeApp();
    const { id } = await standup(t);
    await change(t, id, "2026-11-19", {
      scope: "this",
      startAt: "2026-11-19T12:00:00.000Z",
      endAt: "2026-11-19T12:15:00.000Z",
    });
    await change(t, id, "2026-12-03", { scope: "this", cancelled: true });
    const res = await change(t, id, "2026-11-26", {
      scope: "following",
      startAt: "2026-11-27T09:30:00+01:00",
      endAt: "2026-11-27T10:00:00+01:00",
    });
    const meeting = json<Meeting>(res);
    expect(segments(meeting)).toEqual([
      "2026-11-12..2026-11-25 every week on Thu until 25.11.2026, 09:00–09:15",
      "2026-11-27.. every week on Fri, 09:30–10:00",
    ]);
    // The change on 19.11. stays; the cancel on 03.12. belonged to the old part and is gone.
    expect(await occurrences(t, "from=2026-11-16&to=2026-12-06&cancelled=true")).toEqual([
      "2026-11-19 11-19T12:00 moved",
      "2026-11-27 11-27T08:30 scheduled",
      "2026-12-04 12-04T08:30 scheduled",
    ]);
    const stored = t.deps.db.$client
      .prepare("SELECT occurs_on FROM series_exceptions ORDER BY occurs_on")
      .all();
    expect(stored).toEqual([{ occurs_on: "2026-11-19" }]);
  });

  it("moves all dates of the part with their single date changes", async () => {
    const t = await makeApp();
    const { id } = await standup(t);
    await change(t, id, "2026-11-26", { scope: "this", cancelled: true });
    const meeting = json<Meeting>(
      await change(t, id, "2026-11-19", {
        scope: "all",
        startAt: "2026-11-18T10:00:00+01:00",
        endAt: "2026-11-18T10:30:00+01:00",
      }),
    );
    expect(segments(meeting)).toEqual(["2026-11-11.. every week on Wed, 10:00–10:30"]);
    expect(await occurrences(t, "from=2026-11-09&to=2026-11-29&cancelled=true")).toEqual([
      "2026-11-11 11-11T09:00 scheduled",
      "2026-11-18 11-18T09:00 scheduled",
      "2026-11-25 11-25T09:00 cancelled",
    ]);
  });

  it("changes only the time for this and following when the day stays", async () => {
    const t = await makeApp();
    const { id } = await standup(t);
    const meeting = json<Meeting>(
      await change(t, id, "2026-11-26", {
        scope: "following",
        startAt: "2026-11-26T13:00:00.000Z",
        endAt: "2026-11-26T14:00:00.000Z",
      }),
    );
    expect(segments(meeting)).toEqual([
      "2026-11-12..2026-11-25 every week on Thu until 25.11.2026, 09:00–09:15",
      "2026-11-26.. every week on Thu, 14:00–15:00",
    ]);
  });

  it("offers only this date when the repeat cannot move by days, or would pass an earlier date", async () => {
    const t = await makeApp();
    const monthly = await standup(t, {
      name: "Board",
      schedule: {
        rule: { every: "month", monthWeekday: { nth: 2, weekday: "tue" } },
        startsOn: "2026-11-10",
        startTime: "10:00",
        durationMinutes: 60,
      },
    });
    const move = { startAt: "2026-12-09T09:00:00.000Z", endAt: "2026-12-09T10:00:00.000Z" };
    for (const scope of ["following", "all"]) {
      // oxlint-disable-next-line no-await-in-loop -- one after the other keeps the failing scope readable
      const res = await change(t, monthly.id, "2026-12-08", { scope, ...move });
      expect(`${scope} ${res.statusCode} ${res.json().error.message}`).toBe(
        `${scope} 422 Only this date can move to another day for this repeat.`,
      );
    }
    expect((await change(t, monthly.id, "2026-12-08", { scope: "this", ...move })).statusCode).toBe(200);

    const twice = await standup(t, {
      name: "Twice",
      schedule: {
        rule: weekly(["mon", "thu"]),
        startsOn: "2026-11-16",
        startTime: "09:00",
        durationMinutes: 15,
      },
    });
    const back = await change(t, twice.id, "2026-11-19", {
      scope: "following",
      startAt: "2026-11-16T12:00:00.000Z",
      endAt: "2026-11-16T12:15:00.000Z",
    });
    expect(back.statusCode).toBe(422);
    expect(back.json().error.message).toMatch(/cannot move to or before 16.11.2026/);
  });

  it("cancels this and following: the repeat ends the day before, later parts go", async () => {
    const t = await makeApp();
    const { id } = await standup(t);
    await change(t, id, "2026-12-10", {
      scope: "following",
      startAt: "2026-12-11T08:00:00.000Z",
      endAt: "2026-12-11T08:15:00.000Z",
    });
    const meeting = json<Meeting>(await change(t, id, "2026-11-26", { scope: "following", cancelled: true }));
    expect(segments(meeting)).toEqual([
      "2026-11-12..2026-11-25 every week on Thu until 25.11.2026, 09:00–09:15",
    ]);
    expect(await occurrences(t)).toEqual([
      "2026-11-12 11-12T08:00 scheduled",
      "2026-11-19 11-19T08:00 scheduled",
    ]);
    const first = await change(t, id, "2026-11-12", { scope: "following", cancelled: true });
    expect(first.statusCode).toBe(422);
    expect(first.json().error.message).toMatch(/Delete the meeting/);
  });
});

describe("schedule changes", () => {
  it("splits the repeat from a date on, or rewrites the part and drops dates it no longer has", async () => {
    const t = await makeApp();
    const { id } = await standup(t);
    await change(t, id, "2026-11-19", { scope: "this", cancelled: true });
    await change(t, id, "2026-12-03", { scope: "this", cancelled: true });
    const split = json<Meeting>(
      await t.call("PATCH", `/api/v1/meetings/${id}/schedule`, {
        scope: "following",
        from: "2026-11-26",
        startTime: "10:00",
        durationMinutes: 30,
      }),
    );
    expect(segments(split)).toEqual([
      "2026-11-12..2026-11-25 every week on Thu until 25.11.2026, 09:00–09:15",
      "2026-11-26.. every week on Thu, 10:00–10:30",
    ]);
    expect(await occurrences(t, "from=2026-11-16&to=2026-12-06&cancelled=true")).toEqual([
      "2026-11-19 11-19T08:00 cancelled",
      "2026-11-26 11-26T09:00 scheduled",
      "2026-12-03 12-03T09:00 scheduled",
    ]);
    // "all" on the first part: Fridays from now on; the cancel on Thursday 19.11. no longer fits.
    const all = json<Meeting>(
      await t.call("PATCH", `/api/v1/meetings/${id}/schedule`, {
        scope: "all",
        from: "2026-11-12",
        rule: weekly(["thu", "fri"]),
      }),
    );
    expect(all.segments[0]?.text).toBe("every week on Thu, Fri until 25.11.2026, 09:00–09:15");
    expect(await occurrences(t, "from=2026-11-16&to=2026-11-22&cancelled=true")).toEqual([
      "2026-11-19 11-19T08:00 cancelled",
      "2026-11-20 11-20T08:00 scheduled",
    ]);
    await t.call("PATCH", `/api/v1/meetings/${id}/schedule`, {
      scope: "all",
      from: "2026-11-12",
      rule: weekly(["fri"]),
    });
    expect(await occurrences(t, "from=2026-11-16&to=2026-11-22&cancelled=true")).toEqual([
      "2026-11-20 11-20T08:00 scheduled",
    ]);
  });

  it("refuses a change that runs into the next part and a date the meeting does not have", async () => {
    const t = await makeApp();
    const { id } = await standup(t);
    await t.call("PATCH", `/api/v1/meetings/${id}/schedule`, {
      scope: "following",
      from: "2026-11-26",
      startTime: "10:00",
    });
    const overlap = await t.call("PATCH", `/api/v1/meetings/${id}/schedule`, {
      scope: "all",
      from: "2026-11-12",
      endsOn: null,
    });
    expect(overlap.statusCode).toBe(422);
    expect(overlap.json().error.message).toMatch(/run into another part/);
    const missing = await t.call("PATCH", `/api/v1/meetings/${id}/schedule`, {
      scope: "following",
      from: "2026-11-25",
      startTime: "11:00",
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("changes on the first date and on a split series", () => {
  it("moves and cancels the first date alone, and cancels it again after undoing", async () => {
    const t = await makeApp();
    const { id } = await standup(t);
    await change(t, id, "2026-11-12", { scope: "this", cancelled: true });
    expect(await occurrences(t, "from=2026-11-09&to=2026-11-22&cancelled=true")).toEqual([
      "2026-11-12 11-12T08:00 cancelled",
      "2026-11-19 11-19T08:00 scheduled",
    ]);
    await change(t, id, "2026-11-12", { scope: "this", cancelled: false });
    expect(await occurrences(t, "from=2026-11-09&to=2026-11-15")).toEqual([
      "2026-11-12 11-12T08:00 scheduled",
    ]);
  });

  it("moves following from the first date to another day: one part, no empty earlier part", async () => {
    const t = await makeApp();
    const { id } = await standup(t);
    const meeting = json<Meeting>(
      await change(t, id, "2026-11-12", {
        scope: "following",
        startAt: "2026-11-13T09:00:00+01:00",
        endAt: "2026-11-13T09:15:00+01:00",
      }),
    );
    expect(segments(meeting)).toEqual(["2026-11-13.. every week on Fri, 09:00–09:15"]);
    expect(await occurrences(t, "from=2026-11-09&to=2026-11-22")).toEqual([
      "2026-11-13 11-13T08:00 scheduled",
      "2026-11-20 11-20T08:00 scheduled",
    ]);
  });

  it("changes the time of all dates when the part starts on the first date", async () => {
    const t = await makeApp();
    const { id } = await standup(t);
    await change(t, id, "2026-11-12", {
      scope: "all",
      startAt: "2026-11-12T11:00:00+01:00",
      endAt: "2026-11-12T11:30:00+01:00",
    });
    expect(await occurrences(t, "from=2026-11-09&to=2026-11-22")).toEqual([
      "2026-11-12 11-12T10:00 scheduled",
      "2026-11-19 11-19T10:00 scheduled",
    ]);
  });

  it("works on the second part of a split series without touching the first", async () => {
    const t = await makeApp();
    const { id } = await standup(t);
    await t.call("PATCH", `/api/v1/meetings/${id}/schedule`, {
      scope: "following",
      from: "2026-11-26",
      startTime: "10:00",
    });
    // The second part is the one holding 03.12.: "all" there leaves the first part alone.
    const all = json<Meeting>(
      await t.call("PATCH", `/api/v1/meetings/${id}/schedule`, {
        scope: "all",
        from: "2026-12-03",
        startTime: "11:00",
      }),
    );
    expect(segments(all)).toEqual([
      "2026-11-12..2026-11-25 every week on Thu until 25.11.2026, 09:00–09:15",
      "2026-11-26.. every week on Thu, 11:00–11:15",
    ]);
    // This date of the second part: cancelled on its own, the first part's dates stay.
    await change(t, id, "2026-11-26", { scope: "this", cancelled: true });
    expect(await occurrences(t, "from=2026-11-16&to=2026-12-06&cancelled=true")).toEqual([
      "2026-11-19 11-19T08:00 scheduled",
      "2026-11-26 11-26T10:00 cancelled",
      "2026-12-03 12-03T10:00 scheduled",
    ]);
    // Cancelling following on the first date of the second part ends the series with the first part.
    const cut = json<Meeting>(await change(t, id, "2026-11-26", { scope: "following", cancelled: true }));
    expect(segments(cut)).toEqual(["2026-11-12..2026-11-25 every week on Thu until 25.11.2026, 09:00–09:15"]);
  });

  it("refuses a following move of the second part back into the first part", async () => {
    const t = await makeApp();
    const { id } = await standup(t);
    await t.call("PATCH", `/api/v1/meetings/${id}/schedule`, {
      scope: "following",
      from: "2026-11-26",
      startTime: "10:00",
    });
    const res = await change(t, id, "2026-12-03", {
      scope: "following",
      startAt: "2026-11-19T09:00:00.000Z",
      endAt: "2026-11-19T09:15:00.000Z",
    });
    expect(res.statusCode).toBe(422);
    expect(await occurrences(t, "from=2026-11-16&to=2026-12-06")).toEqual([
      "2026-11-19 11-19T08:00 scheduled",
      "2026-11-26 11-26T09:00 scheduled",
      "2026-12-03 12-03T09:00 scheduled",
    ]);
  });

  it("stops the dates at ends_on and an every-2-weeks repeat skips the weeks between", async () => {
    const t = await makeApp();
    await standup(t, {
      name: "Sync",
      schedule: {
        rule: { every: "week", interval: 2, weekdays: ["thu"] },
        startsOn: "2026-11-12",
        endsOn: "2026-12-10",
        startTime: "09:00",
        durationMinutes: 15,
      },
    });
    expect(await occurrences(t, "from=2026-11-09&to=2027-01-09")).toEqual([
      "2026-11-12 11-12T08:00 scheduled",
      "2026-11-26 11-26T08:00 scheduled",
      "2026-12-10 12-10T08:00 scheduled",
    ]);
  });
});

describe("limits", () => {
  const T = "2026-11-11T10:00:00.000Z";

  it("keeps an account at 100 meetings", async () => {
    const t = await makeApp();
    const sqlite = t.deps.db.$client;
    const add = sqlite.prepare(
      "INSERT INTO meetings (account_id, id, name, type, since, created_at, updated_at) VALUES (?, ?, ?, 'other', ?, ?, ?)",
    );
    for (let id = 1; id <= 99; id += 1) add.run(t.account.id, id, `Meeting ${id}`, T, T, T);
    expect(
      (await t.call("POST", "/api/v1/meetings", { name: "The 100th", schedule: SCHEDULE })).statusCode,
    ).toBe(201);
    const over = await t.call("POST", "/api/v1/meetings", { name: "One more", schedule: SCHEDULE });
    expect(over.statusCode).toBe(422);
    expect(over.json().error.message).toBe(
      "An account can have at most 100 meetings. Delete one you no longer need first.",
    );
    // Another account has its own limit.
    const bobby = await t.asAccount({ username: "bobby" });
    expect(
      (await bobby.call("POST", "/api/v1/meetings", { name: "Mine", schedule: SCHEDULE })).statusCode,
    ).toBe(201);
  });

  it("keeps a repeat at 50 parts and 500 changed dates per part", async () => {
    const t = await makeApp();
    const { id } = await standup(t, { schedule: { ...SCHEDULE, endsOn: "2026-12-31" } });
    const sqlite = t.deps.db.$client;
    const segment = sqlite.prepare(
      `INSERT INTO series (account_id, id, owner_kind, meeting_id, rule, starts_on, ends_on, start_time, duration_min, created_at, updated_at)
       VALUES (?, ?, 'meeting', ?, '{"every":"week","interval":1,"weekdays":["thu"],"basis":"schedule"}', ?, ?, '09:00', 15, ?, ?)`,
    );
    // 49 more one-week parts in 2027 and later.
    for (let k = 0; k < 49; k += 1) {
      const startsOn = addDays("2027-01-07", 7 * k);
      segment.run(t.account.id, 100 + k, id, startsOn, addDays(startsOn, 6), T, T);
    }
    const split = await t.call("PATCH", `/api/v1/meetings/${id}/schedule`, {
      scope: "following",
      from: "2026-11-26",
      startTime: "10:00",
    });
    expect(split.statusCode).toBe(422);
    expect(split.json().error.message).toMatch(/at most 50 parts/);

    const first = json<Meeting>(await t.call("GET", `/api/v1/meetings/${id}`)).segments[0]?.id as number;
    const exception = sqlite.prepare(
      "INSERT INTO series_exceptions (account_id, series_id, occurs_on, kind, created_at, updated_at) VALUES (?, ?, ?, 'cancelled', ?, ?)",
    );
    for (let k = 0; k < 500; k += 1) exception.run(t.account.id, first, addDays("2000-01-01", k), T, T);
    const over = await change(t, id, "2026-11-19", { scope: "this", cancelled: true });
    expect(over.statusCode).toBe(422);
    expect(over.json().error.message).toMatch(/at most 500 moved or cancelled dates/);
    // Changing a date that is changed already still works.
    sqlite.prepare("DELETE FROM series_exceptions WHERE occurs_on = '2000-01-01'").run();
    expect((await change(t, id, "2026-11-19", { scope: "this", cancelled: true })).statusCode).toBe(200);
    expect(
      (
        await change(t, id, "2026-11-19", {
          scope: "this",
          startAt: "2026-11-19T12:00:00.000Z",
          endAt: "2026-11-19T12:15:00.000Z",
        })
      ).statusCode,
    ).toBe(200);
  });

  it("counts each standup's open items with its own window, filter and marks in one list", async () => {
    const t = await makeApp();
    const lab = await t.create<Project>("/api/v1/projects", { name: "Lab" });
    const a = await t.create<{ id: number }>("/api/v1/todos", { title: "In the lab", projectId: lab.id });
    const b = await t.create<{ id: number }>("/api/v1/todos", { title: "In the inbox" });
    await Promise.all([a, b].map((todo) => t.call("PATCH", `/api/v1/todos/${todo.id}`, { status: "done" })));
    const all = await standup(t);
    await standup(t, { name: "Lab standup", filter: { projectIds: [lab.id] } });
    const later = await standup(t, { name: "Late standup", countFrom: "2026-11-12" });
    await t.call("POST", `/api/v1/meetings/${all.id}/standup/marks`, {
      on: "2026-11-12",
      marks: [{ todoId: a.id, kind: "said", coveredUntil: T }],
    });
    const counts = Object.fromEntries(
      json<Meeting[]>(await t.call("GET", "/api/v1/meetings")).map((m) => [m.name, m.openCount]),
    );
    expect(counts).toEqual({ "Weekly Standup": 1, "Lab standup": 1, "Late standup": 0 });
    expect(later.openCount).toBe(0);
  });
});

describe("unreadable stored rows", () => {
  it("leaves a meeting with an unreadable repeat out instead of failing every list", async () => {
    const t = await makeApp();
    const good = await standup(t);
    const bad = await standup(t, { name: "Broken" });
    const sqlite = t.deps.db.$client;
    sqlite
      .prepare(`UPDATE series SET rule = '{"every":"fortnight"}' WHERE account_id = ? AND meeting_id = ?`)
      .run(t.account.id, bad.id);
    sqlite
      .prepare(
        "INSERT INTO series_exceptions (account_id, series_id, occurs_on, kind, start_at, end_at, created_at, updated_at) VALUES (?, ?, 'someday', 'moved', 'x', 'y', ?, ?)",
      )
      .run(t.account.id, good.schedule.id, "2026-11-11T10:00:00.000Z", "2026-11-11T10:00:00.000Z");
    const list = await t.call("GET", "/api/v1/meetings");
    expect(list.statusCode).toBe(200);
    expect(json<Meeting[]>(list).map((m) => m.name)).toEqual(["Weekly Standup"]);
    expect(await occurrences(t, "from=2026-11-09&to=2026-11-15")).toEqual([
      "2026-11-12 11-12T08:00 scheduled",
    ]);
    const one = await t.call("GET", `/api/v1/meetings/${bad.id}`);
    expect(one.statusCode).toBe(409);
    expect(one.json().error.message).toBe(
      `Meeting ${bad.id} has no readable repeat. Delete it and create it again.`,
    );
    await t.call("PATCH", "/api/v1/ai/settings", { provider: "ollama" });
    expect((await t.call("POST", "/api/v1/ai/plan", { day: "2026-11-12" })).statusCode).toBe(200);
    expect((await t.call("GET", `/api/v1/meetings/${good.id}/standup`)).statusCode).toBe(200);
    expect((await t.call("DELETE", `/api/v1/meetings/${bad.id}`)).statusCode).toBe(204);
  });
});
