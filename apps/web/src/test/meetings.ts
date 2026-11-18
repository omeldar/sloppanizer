import type {
  Meeting,
  MeetingOccurrence,
  Series,
  Standup,
  StandupItem,
  StandupKind,
} from "@organizer/shared";

/** Test data for meetings: a weekly Thursday standup at 09:00 for 15 minutes, from 05.11.2026. */

const T = "2026-11-01T09:00:00.000Z";

export function makeSeries(overrides: Partial<Series> = {}): Series {
  return {
    id: 1,
    rule: { every: "week", interval: 1, weekdays: ["thu"], basis: "schedule" },
    startsOn: "2026-11-05",
    endsOn: null,
    startTime: "09:00",
    durationMinutes: 15,
    text: "every week on Thu, 09:00–09:15",
    ...overrides,
  };
}

export function makeOccurrence(overrides: Partial<MeetingOccurrence> = {}): MeetingOccurrence {
  return {
    meetingId: 7,
    seriesId: 1,
    name: "Team standup",
    type: "standup",
    occursOn: "2026-11-19",
    startAt: "2026-11-19T08:00:00.000Z",
    endAt: "2026-11-19T08:15:00.000Z",
    status: "scheduled",
    noteId: null,
    ...overrides,
  };
}

export function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  const series = makeSeries();
  return {
    id: 7,
    name: "Team standup",
    type: "standup",
    filter: { projectIds: [], inbox: false, labelIds: [] },
    since: "2026-11-12T08:00:00.000Z",
    schedule: series,
    segments: [series],
    next: makeOccurrence(),
    openCount: 3,
    createdAt: T,
    updatedAt: T,
    ...overrides,
  };
}

export function makeItem(
  kind: StandupKind,
  id: number,
  title: string,
  overrides: Partial<StandupItem> = {},
): StandupItem {
  return {
    todo: { id, title, status: kind === "done" ? "done" : kind === "blocked" ? "blocked" : "in_progress" },
    project: null,
    parent: null,
    kind,
    at: "2026-11-18T10:00:00.000Z",
    changes: [],
    newCommentCount: 0,
    lastComment: null,
    again: false,
    ...overrides,
  };
}

/** A list for 19.11.2026 with the items' counts filled in. */
export function makeStandup(items: StandupItem[], overrides: Partial<Standup> = {}): Standup {
  const counts = { done: 0, started: 0, updated: 0, blocked: 0 };
  for (const item of items) counts[item.kind] += 1;
  return {
    meetingId: 7,
    on: "2026-11-19",
    since: "2026-11-12T08:00:00.000Z",
    items,
    counts,
    said: [],
    dismissedCount: 0,
    ...overrides,
  };
}
