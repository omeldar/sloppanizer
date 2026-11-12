import type {
  ActivityItem,
  Label,
  NextUp,
  Note,
  Person,
  PersonBrief,
  SearchResult,
  Todo,
} from "@organizer/shared";
import { describe, expect, it } from "vitest";
import {
  activityLine,
  highlight,
  nextUpText,
  noteDetail,
  noteLine,
  personDetail,
  personLine,
  personTagLine,
  searchText,
  statsLine,
  todoDetail,
  todoLine,
  topicLine,
} from "./format.ts";

const ctx = { today: "2026-11-11", timeZone: "Europe/Zurich" };
const at = "2026-10-01T08:00:00.000Z";

const label = (name: string): Label => ({
  id: name.length,
  name,
  scope: name.includes("::") ? name.slice(0, name.lastIndexOf("::")) : null,
  value: name.slice(name.lastIndexOf(":") + 1),
  color: "#FFB224",
  description: "",
  rank: null,
  createdAt: at,
  updatedAt: at,
});

const anna: PersonBrief = {
  id: 7,
  firstName: "Anna",
  lastName: "Meier",
  note: "",
  displayName: "Anna Meier",
  team: "",
  email: "",
};

const max: PersonBrief = {
  id: 9,
  firstName: "Max",
  lastName: "Muster",
  note: "Basel",
  displayName: "Max Muster",
  team: "Network team",
  email: "max.muster@example.com",
};

function person(overrides: Partial<Person> = {}): Person {
  return {
    ...max,
    notesMd: "",
    topics: ["firewall rules", "VPN"],
    tags: [
      {
        id: 1,
        name: "fast reply",
        color: "#3E8E7E",
        description: "",
        peopleCount: 2,
        createdAt: at,
        updatedAt: at,
      },
    ],
    counts: { requested: 0, requestedOpen: 0, requestedDone: 0, contact: 3, contactOpen: 1 },
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function todo(overrides: Partial<Todo> = {}): Todo {
  return {
    id: 142,
    projectId: 3,
    parentId: null,
    title: "Renew SSL certs",
    descriptionMd: "",
    status: "open",
    dueOn: null,
    plannedOn: null,
    position: 0,
    createdAt: at,
    updatedAt: at,
    doneAt: null,
    lastActivityAt: at,
    durationMs: null,
    labels: [],
    requestedBy: [],
    contacts: [],
    commentCount: 0,
    project: { id: 3, slug: "homelab", name: "Home lab", color: "#8B95A5" },
    parent: null,
    progress: { subtasks: { total: 0, done: 0 }, checklist: { total: 0, done: 0 } },
    links: { blocks: [], blockedBy: [], relatesTo: [] },
    recurrence: null,
    previousOccurrenceId: null,
    nextOccurrence: null,
    ...overrides,
  };
}

describe("todoLine", () => {
  it("renders the full line with overdue, age and requester", () => {
    const line = todoLine(
      todo({ dueOn: "2026-11-09", labels: [label("priority::high"), label("homelab")], requestedBy: [anna] }),
      ctx,
    );
    expect(line).toBe(
      "#142 open | Renew SSL certs | priority::high, homelab | project homelab | due 2026-11-09 (overdue 2d) | open 41d | req: Anna Meier",
    );
  });

  it("appends contacts after the requesters", () => {
    expect(todoLine(todo({ requestedBy: [anna], contacts: [max, anna] }), ctx)).toBe(
      "#142 open | Renew SSL certs | project homelab | open 41d | req: Anna Meier | contact: Max Muster, Anna Meier",
    );
  });

  it("says today and in Nd for upcoming due dates and shows the planned day", () => {
    expect(todoLine(todo({ dueOn: "2026-11-11" }), ctx)).toContain("due 2026-11-11 (today)");
    expect(todoLine(todo({ dueOn: "2026-12-01", plannedOn: "2026-11-12" }), ctx)).toContain(
      "due 2026-12-01 (in 20d) | planned 2026-11-12",
    );
  });

  it("shows the inbox when there is no project and leaves out empty parts", () => {
    expect(todoLine(todo({ projectId: null, project: null, status: "blocked" }), ctx)).toBe(
      "#142 blocked | Renew SSL certs | inbox | open 41d",
    );
  });

  it("counts age in local calendar days", () => {
    // 23:30 UTC on Nov 10 is already Nov 11 in Zurich.
    expect(todoLine(todo({ createdAt: "2026-11-10T23:30:00.000Z" }), ctx)).toContain("open 0d");
  });

  it("shows done date and duration instead of age and relative due", () => {
    const line = todoLine(
      todo({
        status: "done",
        dueOn: "2026-11-09",
        plannedOn: "2026-11-08",
        doneAt: "2026-11-04T12:00:00.000Z",
        durationMs: (3 * 24 + 4) * 3_600_000,
      }),
      ctx,
    );
    expect(line).toBe(
      "#142 done | Renew SSL certs | project homelab | due 2026-11-09 | done 2026-11-04, took 3d 4h",
    );
  });
});

describe("todoDetail", () => {
  it("adds dates, people ids and the description", () => {
    const text = todoDetail(todo({ descriptionMd: "Use **certbot**.", requestedBy: [anna] }), ctx);
    expect(text).toContain("created 2026-10-01 (41d ago)");
    expect(text).toContain("requested by: Anna Meier (person 7)");
    expect(text.endsWith("Use **certbot**.")).toBe(true);
  });

  it("lists contacts with id and team and points at the thread when there are comments", () => {
    const text = todoDetail(todo({ contacts: [max, anna], commentCount: 2 }), ctx);
    expect(text).toContain("contacts: Max Muster (person 9, Network team), Anna Meier (person 7)");
    expect(text).toContain("comments: 2 (get_activity shows the thread)");
    expect(todoDetail(todo(), ctx)).not.toContain("comments:");
  });

  it("says when there is no description", () => {
    expect(todoDetail(todo(), ctx)).toContain("(no description)");
  });
});

describe("nextUpText", () => {
  const base: NextUp = { mode: "smart", today: "2026-11-11", generatedAt: at, items: [], blocked: [] };

  it("numbers the items and lists the reasons, blocked apart", () => {
    const text = nextUpText(
      {
        ...base,
        items: [
          {
            todo: todo(),
            score: 52.4,
            reasons: [
              { kind: "overdue", label: "overdue 2d", points: 34 },
              { kind: "priority", label: "priority::high", points: 25 },
            ],
          },
        ],
        blocked: [todo({ id: 9, status: "blocked", title: "Wait for vendor" })],
      },
      "Europe/Zurich",
    );
    expect(text.split("\n")).toEqual([
      "Next up (smart), today 2026-11-11:",
      "1. #142 open | Renew SSL certs | project homelab | open 41d | score 52.4 | why: overdue 2d, priority::high",
      "",
      "Blocked (1):",
      "#9 blocked | Wait for vendor | project homelab | open 41d",
    ]);
  });

  it("explains an empty list", () => {
    expect(nextUpText(base, "Europe/Zurich")).toContain("Nothing open.");
  });
});

describe("statsLine", () => {
  it("mentions a missing export", () => {
    const stats = {
      open: 1,
      inProgress: 0,
      blocked: 0,
      doneLast7Days: 2,
      overdue: 0,
      dueToday: 0,
      plannedToday: 0,
      inbox: 1,
      lastExportAt: null,
    };
    expect(statsLine(stats, ctx)).toMatch(/^open 1, .*done last 7 days 2; never exported$/);
    expect(statsLine({ ...stats, lastExportAt: "2026-11-01T10:00:00.000Z" }, ctx)).toContain(
      "last export 2026-11-01 (10d ago)",
    );
  });
});

describe("personLine", () => {
  it("answers whom to ask: team, topics, tags, counts, then the short note", () => {
    expect(personLine(person())).toBe(
      "person 9 | Max Muster | Network team | topics: firewall rules, VPN | tags: fast reply | contact for 3 (1 open) | note: Basel",
    );
    expect(
      personLine(
        person({
          team: "",
          note: "",
          topics: [],
          tags: [],
          counts: { requested: 4, requestedOpen: 1, requestedDone: 3, contact: 0, contactOpen: 0 },
        }),
      ),
    ).toBe("person 9 | Max Muster | requested 4 (1 open)");
  });

  it("works with the brief form of todos and conflict candidates", () => {
    expect(personLine(max)).toBe("person 9 | Max Muster | Network team | note: Basel");
    expect(personLine(anna)).toBe("person 7 | Anna Meier");
  });
});

describe("personDetail", () => {
  it("shows every field, the open todos per role and the notes last", () => {
    const text = personDetail(
      person({ notesMd: "Prefers **Teams** over mail.", email: "" }),
      { requested: [], contactFor: [todo({ contacts: [max] })] },
      ctx,
    );
    const lines = text.split("\n");
    expect(lines.slice(0, 8)).toEqual([
      "person 9 | Max Muster",
      "note: Basel",
      "team: Network team",
      "email: (none)",
      "topics: firewall rules, VPN",
      "tags: fast reply",
      "requested 0 (0 open, 0 done), contact for 3 (1 open)",
      "created 2026-10-01 (41d ago), updated 2026-10-01 (41d ago)",
    ]);
    expect(text).toContain("Open todos they requested (0):\nNone.");
    expect(text).toContain(
      "Open todos they are a contact for (1):\n#142 open | Renew SSL certs | project homelab | open 41d | contact: Max Muster",
    );
    expect(text.endsWith("Notes:\nPrefers **Teams** over mail.")).toBe(true);
  });
});

describe("topics and person tags", () => {
  it("counts people with the right word", () => {
    expect(topicLine({ id: 3, name: "VPN", peopleCount: 1 })).toBe("topic 3 | VPN | 1 person");
    expect(
      personTagLine({
        id: 1,
        name: "needs a ticket",
        color: "#F2555A",
        description: "Open a ticket first",
        peopleCount: 0,
        createdAt: at,
        updatedAt: at,
      }),
    ).toBe("needs a ticket | #F2555A | 0 people | Open a ticket first");
  });
});

describe("activityLine", () => {
  it("shows local time, actor and the event in words", () => {
    const item: ActivityItem = {
      type: "event",
      event: {
        id: 1,
        todoId: 142,
        actor: "you",
        kind: "status_changed",
        data: { from: "open", to: "done" },
        createdAt: "2026-11-12T13:03:00.000Z",
      },
    };
    expect(activityLine(item, "Europe/Zurich")).toBe(
      "2026-11-12 14:03 you: changed status from Open to Done",
    );
  });

  it("shows comments with their id and text, indenting further lines", () => {
    const comment = {
      id: 12,
      todoId: 142,
      actor: "planner",
      bodyMd: "Ordered the part.\nArrives Monday.\n",
      createdAt: "2026-11-12T13:05:00.000Z",
      updatedAt: "2026-11-12T13:05:00.000Z",
      editedAt: null,
    };
    expect(activityLine({ type: "comment", comment }, "Europe/Zurich")).toBe(
      "2026-11-12 14:05 planner commented (comment 12): Ordered the part.\n  Arrives Monday.",
    );
    expect(
      activityLine({ type: "comment", comment: { ...comment, editedAt: at } }, "Europe/Zurich"),
    ).toContain("(comment 12, edited)");
  });
});

describe("notes", () => {
  const note: Note = {
    id: 4,
    projectId: 3,
    project: { id: 3, slug: "homelab", name: "Home lab", color: "#8B95A5" },
    title: "Router setup",
    bodyMd: "## VLANs\n\n- 10 home",
    pinnedAt: at,
    createdBy: "you",
    createdAt: at,
    updatedAt: "2026-11-10T08:00:00.000Z",
  };

  it("lists a summary on one line", () => {
    const { bodyMd: _body, ...rest } = note;
    expect(noteLine({ ...rest, excerpt: "VLANs\n 10 home" }, ctx)).toBe(
      "note 4 | Router setup | project homelab | pinned | updated 2026-11-10 | VLANs 10 home",
    );
    expect(noteLine({ ...rest, project: null, projectId: null, pinnedAt: null, excerpt: "" }, ctx)).toBe(
      "note 4 | Router setup | no project | updated 2026-11-10",
    );
  });

  it("shows the body after the header", () => {
    expect(noteDetail(note, ctx).split("\n")).toEqual([
      "note 4 | Router setup | project homelab | pinned | updated 2026-11-10",
      "created 2026-10-01 (41d ago) by you",
      "",
      "## VLANs",
      "",
      "- 10 home",
    ]);
  });
});

describe("search", () => {
  it("marks highlights in bold, clamped and merged", () => {
    expect(highlight("the firewall rules", [[4, 12]])).toBe("the **firewall** rules");
    expect(
      highlight("one two three", [
        [8, 13],
        [0, 3],
      ]),
    ).toBe("**one** two **three**");
    expect(
      highlight("abcdef", [
        [3, 5],
        [0, 2],
        [1, 3],
        [4, 99],
        [5, 5],
      ]),
    ).toBe("**abcdef**");
  });

  it("groups hits by kind with the totals", () => {
    const result: SearchResult = {
      q: "firewall",
      items: [
        {
          kind: "person",
          id: 9,
          title: "Max Muster",
          snippet: "Network team firewall rules",
          highlights: [[13, 21]],
          todoId: null,
          status: null,
          subtitle: "Network team | firewall rules",
        },
        {
          kind: "todo",
          id: 142,
          title: "Open the firewall",
          snippet: "Open the firewall",
          highlights: [[9, 17]],
          todoId: 142,
          status: "open",
          subtitle: null,
        },
        {
          kind: "comment",
          id: 12,
          title: "",
          snippet: "asked about the firewall",
          highlights: [[16, 24]],
          todoId: 142,
          status: null,
          subtitle: "you, 2026-11-12",
        },
      ],
      counts: { todo: 3, note: 0, comment: 1, person: 1 },
    };
    expect(searchText(result).split("\n")).toEqual([
      'Found for "firewall": 3 todos, 0 notes, 1 comment, 1 person.',
      "",
      "Todos (showing 1 of 3):",
      "#142 open | Open the firewall",
      "",
      "Comments:",
      "comment 12 on #142 | you, 2026-11-12 | asked about the **firewall**",
      "",
      "People:",
      "person 9 | Max Muster | Network team | firewall rules | Network team **firewall** rules",
    ]);
    expect(searchText({ q: "zz", items: [], counts: { todo: 0, note: 0, comment: 0, person: 0 } })).toBe(
      'Nothing found for "zz".',
    );
  });
});
