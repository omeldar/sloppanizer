import type { Label, NextUp, Person, Todo } from "@organizer/shared";
import { describe, expect, it } from "vitest";
import { nextUpText, statsLine, todoDetail, todoLine } from "./format.ts";

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

const anna: Person = {
  id: 7,
  firstName: "Anna",
  lastName: "Meier",
  note: "",
  displayName: "Anna Meier",
  createdAt: at,
  updatedAt: at,
};

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
    project: { id: 3, slug: "homelab", name: "Home lab", color: "#8B95A5" },
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
