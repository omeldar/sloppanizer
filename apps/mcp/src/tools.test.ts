import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  Activity,
  Comment,
  Meeting,
  Note,
  Person,
  Project,
  Space,
  Standup,
  StandupItem,
  Todo,
} from "@organizer/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type Api, ApiError } from "./api.ts";
import { registerTools } from "./tools.ts";

// The tools against a fake API: which requests they send and what they make of the answers.

const at = "2026-10-01T08:00:00.000Z";
const NOW = new Date("2026-11-11T09:00:00.000Z");

interface Call {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  /** The shared project the call went to (Api.inSpace). */
  space?: number;
}

type Handler = (call: Call) => unknown;

/**
 * The account's shared projects, as GET /spaces lists them, are answered here unless the handler
 * answers them itself: none, and the call is not recorded, so tests about own todos see their own calls.
 */
function fakeApi(handler: Handler): { api: Api; calls: Call[] } {
  const calls: Call[] = [];
  const run = async (call: Call) => {
    const answer = handler(call);
    if (call.path === "/spaces" && call.space === undefined && answer === undefined) return [];
    calls.push(call);
    return answer;
  };
  const make = (space?: number): Api => {
    const where = space === undefined ? {} : { space };
    return {
      get: async (path, query) =>
        run({ method: "GET", path, query: query as Record<string, unknown>, ...where }) as never,
      post: async (path, body) => run({ method: "POST", path, body, ...where }) as never,
      patch: async (path, body) => run({ method: "PATCH", path, body, ...where }) as never,
      delete: async (path, query) => {
        await run({ method: "DELETE", path, query: query as Record<string, unknown>, ...where });
      },
      inSpace: (id) => make(id),
    };
  };
  return { api: make(), calls };
}

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

const plannedSeries = {
  id: 3,
  rule: { every: "week", interval: 1, weekdays: ["thu"], basis: "schedule" },
  startsOn: "2026-11-12",
  endsOn: null,
  startTime: "10:00",
  durationMinutes: 60,
  text: "every week on Thu, 10:00–11:00",
};
const planned = (occursOn: string, startAt: string, endAt: string, status = "scheduled") => ({
  seriesId: 3,
  ownerTodoId: 12,
  todo: { id: 12, title: "Team report", status: "open" },
  project: { id: 1, slug: "lab", name: "Lab", color: "#4c9aff" },
  occursOn,
  startAt,
  endAt,
  status,
});

async function connect(handler: Handler) {
  const { api, calls } = fakeApi(handler);
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server, { api, timeZone: "Europe/Zurich", now: () => NOW });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { text: string }[];
    return { text: content.map((c) => c.text).join("\n"), isError: result.isError === true };
  };
  return { call, calls };
}

function person(overrides: Partial<Person> = {}): Person {
  return {
    id: 9,
    firstName: "Max",
    lastName: "Muster",
    displayName: "Max Muster",
    note: "",
    team: "Network team",
    email: "",
    notesMd: "",
    username: "",
    languages: [],
    topics: ["VPN"],
    tags: [],
    counts: { requested: 0, requestedOpen: 0, requestedDone: 0, contact: 1, contactOpen: 1 },
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function todo(overrides: Partial<Todo> = {}): Todo {
  return {
    id: 142,
    projectId: null,
    parentId: null,
    title: "Open port 443",
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
    project: null,
    parent: null,
    progress: { subtasks: { total: 0, done: 0 }, checklist: { total: 0, done: 0 } },
    links: { blocks: [], blockedBy: [], relatesTo: [] },
    urls: [],
    recurrence: null,
    previousOccurrenceId: null,
    nextOccurrence: null,
    assignee: null,
    actionNeeded: null,
    ...overrides,
  };
}

const note = (overrides: Partial<Note> = {}): Note => ({
  id: 4,
  projectId: null,
  project: null,
  title: "Log",
  bodyMd: "",
  pinnedAt: null,
  createdBy: "you",
  createdAt: at,
  updatedAt: at,
  ...overrides,
});

const homelab: Project = {
  id: 3,
  slug: "homelab",
  name: "Home lab",
  description: "",
  color: "#8B95A5",
  archivedAt: null,
  createdAt: at,
  updatedAt: at,
  openCount: 0,
};

const page = (items: Todo[]) => ({ items, total: items.length, limit: 100, offset: 0 });

describe("people tools", () => {
  it("list_people sends every filter and answers whom to ask", async () => {
    const { call, calls } = await connect(() => [person()]);
    const result = await call("list_people", {
      topic: ["VPN", "firewall rules"],
      tag: ["fast reply"],
      team: "Network team",
      kind: "contact",
      sort: "contact",
    });
    expect(calls[0]).toEqual({
      method: "GET",
      path: "/people",
      query: {
        q: undefined,
        topic: ["VPN", "firewall rules"],
        team: "Network team",
        tag: ["fast reply"],
        kind: "contact",
        sort: "contact",
      },
    });
    expect(result.text).toBe("person 9 | Max Muster | Network team | topics: VPN | contact for 1 (1 open)");
  });

  it("get_person finds the exact name among the search hits and loads both todo lists", async () => {
    const { call, calls } = await connect(({ path, query }) => {
      if (path === "/people") return [person({ id: 2, lastName: "Musterli" }), person()];
      if (path === "/people/9") return person({ notesMd: "Knows the **old** firewall." });
      if (path === "/todos" && query?.personRole === "contact") return page([todo({ contacts: [] })]);
      return page([]);
    });
    const result = await call("get_person", { person: "max muster" });
    expect(result.isError).toBe(false);
    expect(calls.map((c) => [c.path, c.query?.personRole, c.query?.personId])).toEqual([
      ["/people", undefined, undefined],
      ["/people/9", undefined, undefined],
      ["/todos", "requester", 9],
      ["/todos", "contact", 9],
    ]);
    expect(calls[0]?.query?.q).toBe("max muster");
    expect(result.text).toContain("Open todos they are a contact for (1):\n#142 open | Open port 443");
    expect(result.text.endsWith("Knows the **old** firewall.")).toBe(true);
  });

  it("get_person lists namesakes instead of guessing, and says when no one has the name", async () => {
    const twins = await connect(() => [person({ id: 1, note: "Basel" }), person({ id: 2, note: "Zug" })]);
    const ambiguous = await twins.call("get_person", { person: "Max Muster" });
    expect(ambiguous).toEqual({
      isError: true,
      text: [
        'Several people are named "Max Muster"; pass the person id:',
        "person 1 | Max Muster | Network team | topics: VPN | contact for 1 (1 open) | note: Basel",
        "person 2 | Max Muster | Network team | topics: VPN | contact for 1 (1 open) | note: Zug",
      ].join("\n"),
    });
    const nobody = await connect(() => [person({ firstName: "Maxi" })]);
    expect((await nobody.call("get_person", { person: "Max Muster" })).text).toBe(
      'No person named "Max Muster". list_people searches by name, team and topic.',
    );
  });

  it("update_person sends notes as notesMd and only the given fields", async () => {
    const { call, calls } = await connect(({ method }) => (method === "PATCH" ? person() : []));
    const result = await call("update_person", {
      person: 9,
      notes: "## Context",
      addTopics: ["firewall rules"],
      removeTags: ["slow"],
      email: "",
    });
    expect(calls).toEqual([
      {
        method: "PATCH",
        path: "/people/9",
        body: { email: "", addTopics: ["firewall rules"], removeTags: ["slow"], notesMd: "## Context" },
      },
    ]);
    expect(result.text).toMatch(/^Updated person 9 \| Max Muster/);
  });

  it("create_person passes team, email, languages, topics and tags", async () => {
    const { call, calls } = await connect(() => person());
    await call("create_person", {
      firstName: "Max",
      lastName: "Muster",
      team: "Network team",
      email: "max@example.com",
      languages: ["en", "de"],
      topics: ["VPN"],
      tags: ["fast reply"],
    });
    expect(calls[0]?.body).toEqual({
      firstName: "Max",
      lastName: "Muster",
      team: "Network team",
      email: "max@example.com",
      languages: ["de", "en"],
      topics: ["VPN"],
      tags: ["fast reply"],
    });
  });

  it("update_person sets languages, also to none, and refuses unknown codes before calling the API", async () => {
    const { call, calls } = await connect(() => person());
    await call("update_person", { person: 9, languages: [] });
    expect(calls).toEqual([{ method: "PATCH", path: "/people/9", body: { languages: [] } }]);
    const refused = await call("update_person", { person: 9, languages: ["fr"] });
    expect(refused.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("explains unknown person tags and a taken tag name", async () => {
    const unknown = await connect(() => {
      throw new ApiError(422, "validation_failed", "Unknown person tags: slow.", { unknownTags: ["slow"] });
    });
    expect((await unknown.call("update_person", { person: 9, addTags: ["slow"] })).text).toBe(
      "Unknown person tags: slow.\nlist_person_tags shows the person tags; the user adds new ones on the Labels page.",
    );
  });
});

describe("todo tools with contacts", () => {
  it("update_todo resolves contacts like requesters", async () => {
    const { call, calls } = await connect(() => todo({ contacts: [person()] }));
    const result = await call("update_todo", {
      id: 142,
      addContacts: ["Max Muster", 7],
      removeContacts: [{ firstName: "Anna", lastName: "van Berg" }],
    });
    expect(calls[0]?.body).toEqual({
      addContacts: [{ firstName: "Max", lastName: "Muster" }, { personId: 7 }],
      removeContacts: [{ firstName: "Anna", lastName: "van Berg" }],
    });
    expect(result.text).toBe("Updated #142 open | Open port 443 | inbox | open 41d | contact: Max Muster");
  });

  it("list_todos passes the person role and planning filters", async () => {
    const { call, calls } = await connect(() => page([]));
    await call("list_todos", {
      personId: 9,
      personRole: "any",
      plannedFrom: "2026-11-09",
      plannedTo: "2026-11-15",
    });
    expect(calls[0]?.query).toMatchObject({
      personId: 9,
      personRole: "any",
      plannedFrom: "2026-11-09",
      plannedTo: "2026-11-15",
    });
  });
});

describe("thread tools", () => {
  const comment: Comment = {
    id: 5,
    todoId: 142,
    actor: "planner",
    bodyMd: "Asked Max.",
    createdAt: "2026-11-11T08:00:00.000Z",
    updatedAt: "2026-11-11T08:00:00.000Z",
    editedAt: null,
  };
  const activity: Activity = {
    todoId: 142,
    items: [
      {
        type: "event",
        event: { id: 1, todoId: 142, actor: "you", kind: "created", data: {}, createdAt: at },
      },
      { type: "comment", comment },
    ],
  };

  it("get_activity shows the newest items when limited", async () => {
    const { call } = await connect(() => activity);
    expect((await call("get_activity", { todo: 142, limit: 1 })).text).toBe(
      "#142 activity (2 items, the newest 1):\n11.11.2026 09:00 planner commented (comment 5): Asked Max.",
    );
    const all = await call("get_activity", { todo: 142 });
    expect(all.text.split("\n")).toHaveLength(3);
  });

  it("add_comment posts the text and says who signed it", async () => {
    const { call, calls } = await connect(() => comment);
    const result = await call("add_comment", { todo: 142, text: "Asked Max." });
    expect(calls[0]).toEqual({ method: "POST", path: "/todos/142/comments", body: { bodyMd: "Asked Max." } });
    expect(result.text).toBe("Added comment 5 to #142 as planner.");
  });

  it("search sends kinds as a list", async () => {
    const { call, calls } = await connect(() => ({
      q: "vpn",
      items: [],
      counts: { todo: 0, note: 0, comment: 0, person: 0 },
    }));
    expect((await call("search", { q: "vpn", kinds: ["person", "note"] })).text).toBe(
      'Nothing found for "vpn".',
    );
    expect(calls[0]?.query).toEqual({ q: "vpn", kinds: ["person", "note"], limit: 10 });
  });
});

describe("note tools", () => {
  it("list_notes maps none and slugs to the project filter", async () => {
    const { call, calls } = await connect(({ path }) =>
      path === "/projects" ? [homelab] : { items: [], total: 0, limit: 50, offset: 0 },
    );
    expect((await call("list_notes", { project: "none" })).text).toBe(
      "No notes match. create_note adds one.",
    );
    await call("list_notes", { project: "inbox", pinned: true });
    await call("list_notes", { project: "homelab" });
    const notesCalls = calls
      .filter((c) => c.path === "/notes")
      .map((c) => [c.query?.projectId, c.query?.pinned]);
    expect(notesCalls).toEqual([
      ["none", undefined],
      ["none", true],
      [3, undefined],
    ]);
  });

  it("update_note leaves the append to the server (one PATCH, no read first) and refuses body plus appendText", async () => {
    const { call, calls } = await connect(() => note({ bodyMd: "- first\n\n- second" }));
    const result = await call("update_note", { id: 4, appendText: "- second", project: null });
    expect(calls).toEqual([
      { method: "PATCH", path: "/notes/4", body: { appendMd: "- second", projectId: null } },
    ]);
    expect(result.isError).toBe(false);
    const both = await call("update_note", { id: 4, body: "x", appendText: "y" });
    expect(both).toEqual({
      isError: true,
      text: "Give either body (replaces the text) or appendText (adds to it), not both.",
    });
    expect(calls).toHaveLength(1);
  });

  it("update_note refuses an appendText that is only whitespace", async () => {
    const { call, calls } = await connect(() => note());
    const result = await call("update_note", { id: 4, appendText: "  \n " });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Write something to append.");
    expect(calls).toEqual([]);
  });
});

describe("inputs follow the shared rules", () => {
  it("refuses a topic filter with a comma instead of splitting it into two topics", async () => {
    const { call, calls } = await connect(() => [person()]);
    const result = await call("list_people", { topic: ["VPN,firewall"] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Topic names cannot contain commas");
    expect(calls).toEqual([]);
  });

  it("refuses person tags with a comma or label syntax before calling the API", async () => {
    const { call, calls } = await connect(() => person());
    const comma = await call("create_person", { firstName: "Max", lastName: "Muster", tags: ["a,b"] });
    expect(comma.isError).toBe(true);
    expect(comma.text).toContain("Tag names cannot contain commas");
    const scoped = await call("list_people", { tag: ["team::net"] });
    expect(scoped.isError).toBe(true);
    expect(scoped.text).toContain('Person tag names cannot contain "::"');
    expect(calls).toEqual([]);
  });

  it("uses the server's limits, so a request the API would refuse is caught here", async () => {
    const { call, calls } = await connect(() => []);
    const topics = await call("list_topics", { limit: 300 });
    expect(topics.isError).toBe(true);
    const title = await call("create_todo", { title: "x".repeat(301) });
    expect(title.isError).toBe(true);
    expect(title.text).toContain("Keep the title at 300 characters or fewer.");
    const ids = await call("bulk_update", { ids: [1, 1], status: "done" });
    expect(ids.isError).toBe(true);
    expect(ids.text).toContain("Each id may appear only once.");
    expect(calls).toEqual([]);
    await call("list_topics", { limit: 200 });
    expect(calls).toEqual([{ method: "GET", path: "/topics", query: { q: undefined, limit: 200 } }]);
  });

  it("normalizes topic names like the server (inner spaces collapsed)", async () => {
    const { call, calls } = await connect(() => [person()]);
    await call("list_people", { topic: ["  firewall   rules "] });
    expect(calls[0]?.query?.topic).toEqual(["firewall rules"]);
  });
});

const ref = (id: number, title: string, status: Todo["status"] = "open") => ({ id, title, status });

describe("step 3 tools", () => {
  it("list_todos passes the parent filter", async () => {
    const { call, calls } = await connect(() => page([]));
    await call("list_todos", { parent: "none" });
    await call("list_todos", { parent: 42 });
    expect(calls.map((c) => c.query?.parentId)).toEqual(["none", 42]);
  });

  it("get_todo shows parent, subtasks, checklist numbers, links and the repeat", async () => {
    const parent = todo({
      id: 42,
      title: "Rack setup",
      parent: ref(7, "Home lab"),
      descriptionMd: "Steps:\n- [x] Order cables\n- [ ] Mount rails\n",
      progress: { subtasks: { total: 2, done: 1 }, checklist: { total: 2, done: 1 } },
      links: { blocks: [ref(50, "Install server")], blockedBy: [ref(12, "Buy rack")], relatesTo: [] },
      recurrence: { every: "week", interval: 1, weekdays: ["mon"], basis: "schedule" },
      nextOccurrence: ref(143, "Rack setup"),
    });
    const { call, calls } = await connect(({ path }) =>
      path === "/todos/42"
        ? parent
        : page([
            todo({ id: 43, title: "Cable" }),
            todo({ id: 44, title: "Label", status: "done", doneAt: at }),
          ]),
    );
    const { text } = await call("get_todo", { id: 42 });
    expect(calls[1]).toMatchObject({
      path: "/todos",
      query: { parentId: 42, status: "all", sort: "position" },
    });
    const lines = text.split("\n");
    expect(lines[0]).toContain("| 1/2 subtasks | checklist 1/2 | waiting on #12 | repeats every week on Mon");
    expect(lines).toContain("Subtask of #7 Home lab");
    expect(lines).toContain("blocked by: #12 Buy rack (open)");
    expect(lines).toContain("blocks: #50 Install server (open)");
    expect(lines).toContain("Repeats every week on Mon (next: #143)");
    expect(lines).toContain("Subtasks (1/2 done):");
    expect(lines.some((l) => l.startsWith("- #43 open | Cable"))).toBe(true);
    expect(lines).toContain("[x] 0 Order cables");
    expect(lines).toContain("[ ] 1 Mount rails");
  });

  it("get_todo does not ask for subtasks when there are none", async () => {
    const { call, calls } = await connect(() => todo());
    await call("get_todo", { id: 142 });
    expect(calls).toHaveLength(1);
  });

  it("create_todo and update_todo send parent and repeat; null clears them", async () => {
    const { call, calls } = await connect(() => todo());
    const rule = { every: "month", monthDay: -1 };
    await call("create_todo", { title: "Pay rent", dueOn: "2026-11-30", parent: 42, repeat: rule });
    expect(calls[0]?.body).toEqual({
      title: "Pay rent",
      dueOn: "2026-11-30",
      parentId: 42,
      recurrence: { every: "month", monthDay: -1, interval: 1, basis: "schedule" },
    });
    await call("update_todo", { id: 142, parent: null, repeat: null });
    expect(calls[1]?.body).toEqual({ parentId: null, recurrence: null });
  });

  it("refuses a repeat rule the API would refuse, with the shared message", async () => {
    const { call, calls } = await connect(() => todo());
    const result = await call("create_todo", {
      title: "x",
      dueOn: "2026-11-30",
      repeat: { every: "day", interval: 3, basis: "done", weekdays: ["mon"] },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Weekdays only work with a weekly repeat.");
    expect(calls).toEqual([]);
  });

  it("mark_done withSubtasks marks open subtasks of every level and reports the next occurrence", async () => {
    const children: Record<number, number[]> = { 42: [43, 44], 43: [45], 44: [], 45: [] };
    const { call, calls } = await connect(({ method, path, query, body }) => {
      if (method === "GET" && path === "/todos") {
        return page((children[query?.parentId as number] ?? []).map((id) => todo({ id })));
      }
      if (method === "POST") {
        const ids = (body as { ids: number[] }).ids;
        return {
          updated: ids.map((id) =>
            todo({ id, status: "done", doneAt: at, nextOccurrence: id === 42 ? ref(143, "Weekly") : null }),
          ),
        };
      }
      return todo({ id: 143, title: "Weekly", dueOn: "2026-11-18" });
    });
    const { text } = await call("mark_done", { ids: [42], withSubtasks: true });
    const bulk = calls.find((c) => c.method === "POST");
    expect(bulk?.body).toEqual({ ids: [42, 43, 44, 45], patch: { status: "done" } });
    expect(
      calls.filter((c) => c.method === "GET" && c.path === "/todos").map((c) => c.query?.parentId),
    ).toEqual([42, 43, 44, 45]);
    expect(calls.at(-1)?.path).toBe("/todos/143");
    expect(text).toContain("Next occurrence:\n#143 open | Weekly");
  });

  it("mark_done without withSubtasks leaves subtasks alone", async () => {
    const { call, calls } = await connect(() => ({ updated: [todo({ status: "done", doneAt: at })] }));
    const { text } = await call("mark_done", { ids: [142] });
    expect(calls).toHaveLength(1);
    expect(text).not.toContain("Next occurrence");
  });

  it("add_subtasks posts the titles in order", async () => {
    const { call, calls } = await connect(() => [todo({ id: 43, title: "a" }), todo({ id: 44, title: "b" })]);
    const { text } = await call("add_subtasks", { todo: 42, titles: ["a", "b"] });
    expect(calls[0]).toEqual({ method: "POST", path: "/todos/42/subtasks", body: { titles: ["a", "b"] } });
    expect(text.split("\n")[0]).toBe("Added 2 subtasks to #42:");
  });

  describe("check_item", () => {
    const withList = todo({
      id: 42,
      descriptionMd: "- [ ] Order cables\n- [x] Mount rails\n- [ ] order cables\n",
    });

    it("ticks by number and sends the text it saw", async () => {
      const { call, calls } = await connect(({ method }) => (method === "GET" ? withList : withList));
      const { text } = await call("check_item", { todo: 42, item: 1, checked: false });
      expect(calls[1]).toEqual({
        method: "POST",
        path: "/todos/42/checklist",
        body: { index: 1, checked: false, text: "Mount rails" },
      });
      expect(text).toMatch(/^Unchecked "Mount rails" on #42/);
    });

    it("finds the exact text first and asks for the number when only a case-insensitive match is ambiguous", async () => {
      const { call, calls } = await connect(() => withList);
      await call("check_item", { todo: 42, item: "order cables" });
      expect(calls[1]?.body).toEqual({ index: 2, checked: true, text: "order cables" });
      const ambiguous = await connect(() => todo({ descriptionMd: "- [ ] A\n- [ ] a b\n- [ ] A\n" }));
      const result = await ambiguous.call("check_item", { todo: 142, item: "A" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Several items read "A"; pass the number.');
    });

    it("lists the items when the one asked for is missing, and when the checklist changed meanwhile", async () => {
      const { call } = await connect(({ method }) => {
        if (method === "GET") return withList;
        throw new ApiError(409, "conflict", "The checklist changed; reload and try again.", {
          items: [{ index: 0, text: "Order cables", checked: true, line: 0 }],
        });
      });
      const missing = await call("check_item", { todo: 42, item: 7 });
      expect(missing.text).toContain("No item 7 on #42.\nThe checklist reads:\n[ ] 0 Order cables");
      const stale = await call("check_item", { todo: 42, item: 0 });
      expect(stale).toEqual({
        isError: true,
        text: "The checklist changed; reload and try again.\nThe checklist now reads:\n[x] 0 Order cables",
      });
    });

    it("says when the todo has no checklist", async () => {
      const { call } = await connect(() => todo());
      expect(await call("check_item", { todo: 142, item: 0 })).toEqual({
        isError: true,
        text: "#142 has no checklist in its description.",
      });
    });
  });

  it("link_todos and unlink_todos send the kind seen from the todo; a loop names the chain", async () => {
    const { call, calls } = await connect(({ method, body }) => {
      if (method === "POST" && (body as { links: { todoId: number }[] }).links[0]?.todoId === 1) {
        throw new ApiError(422, "validation_failed", "That link would make a loop.", { chain: [1, 2, 1] });
      }
      return todo({ id: 2 });
    });
    const linked = await call("link_todos", { todo: 2, kind: "blocked_by", other: 12 });
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/todos/2/links",
      body: { links: [{ kind: "blocked_by", todoId: 12 }] },
    });
    expect(linked.text.split("\n")[0]).toBe("Linked: #2 is blocked by #12.");
    const loop = await call("link_todos", { todo: 2, kind: "blocks", other: 1 });
    expect(loop).toEqual({
      isError: true,
      text: "That link would make a loop.\nChain: #1 blocks #2 blocks #1",
    });
    const removed = await call("unlink_todos", { todo: 2, kind: "relates", other: 9 });
    expect(calls.at(-1)).toEqual({ method: "DELETE", path: "/todos/2/links/9", query: { kind: "relates" } });
    expect(removed.text).toBe("Removed the link: #2 relates to #9.");
  });

  it("people_stats sends the filters and prints one line per person", async () => {
    const stats = {
      from: "2026-01-01",
      to: null,
      role: "requester",
      totals: { todos: 14, open: 3, done: 11, medianDoneMs: 187_200_000 },
      items: [
        {
          person: {
            id: 7,
            firstName: "Anna",
            lastName: "Meier",
            displayName: "Anna Meier",
            note: "",
            team: "Platform",
          },
          requested: {
            total: 14,
            open: 3,
            done: 11,
            medianDoneMs: 187_200_000,
            p90DoneMs: null,
            oldestOpenDays: 12,
            lastAt: at,
          },
          contact: { total: 5, open: 1, done: 4 },
        },
        {
          person: {
            id: 8,
            firstName: "Max",
            lastName: "Muster",
            displayName: "Max Muster",
            note: "",
            team: "",
          },
          requested: {
            total: 0,
            open: 0,
            done: 0,
            medianDoneMs: null,
            p90DoneMs: null,
            oldestOpenDays: null,
            lastAt: null,
          },
          contact: { total: 2, open: 2, done: 0 },
        },
      ],
    };
    const { call, calls } = await connect(({ path }) => (path === "/projects" ? [homelab] : stats));
    const { text } = await call("people_stats", {
      from: "2026-01-01",
      topic: ["VPN"],
      project: "homelab",
      sort: "speed",
    });
    expect(calls.at(-1)).toEqual({
      method: "GET",
      path: "/stats/people",
      query: {
        from: "2026-01-01",
        to: undefined,
        role: "requester",
        topic: ["VPN"],
        tag: undefined,
        team: undefined,
        label: undefined,
        projectId: homelab.id,
        sort: "speed",
        limit: 50,
      },
    });
    expect(text.split("\n")).toEqual([
      "People as requesters, todos created 01.01.2026 to today: 14 (3 open, 11 done, median took 2d 4h):",
      "Anna Meier | Platform | requested 14, open 3, done 11, median took 2d 4h | contact 5",
      "Max Muster | requested 0, open 0, done 0 | contact 2",
    ]);
  });
});

// ---------- meetings ----------

const series = {
  id: 1,
  rule: { every: "week" as const, interval: 1, weekdays: ["thu" as const], basis: "schedule" as const },
  startsOn: "2026-11-12",
  endsOn: null,
  startTime: "09:00",
  durationMinutes: 15,
  text: "every week on Thu, 09:00–09:15",
};

function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: 2,
    name: "Weekly Standup",
    type: "standup",
    filter: { projectIds: [], inbox: false, labelIds: [] },
    since: "2026-11-05T08:00:00.000Z",
    schedule: series,
    segments: [series],
    oneTime: false,
    people: [],
    next: {
      meetingId: 2,
      seriesId: 1,
      name: "Weekly Standup",
      type: "standup",
      occursOn: "2026-11-12",
      startAt: "2026-11-12T08:00:00.000Z",
      endAt: "2026-11-12T08:15:00.000Z",
      status: "scheduled",
      noteId: null,
      oneTime: false,
    },
    openCount: 2,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

const standupItem = (id: number, title: string, kind: StandupItem["kind"], when: string): StandupItem => ({
  todo: { id, title, status: kind === "done" ? "done" : kind === "blocked" ? "blocked" : "in_progress" },
  project: null,
  parent: null,
  kind,
  at: when,
  changes: [],
  newCommentCount: 0,
  lastComment: null,
  again: false,
});

const standupOf = (items: StandupItem[], said: Standup["said"] = []): Standup => ({
  meetingId: 2,
  on: "2026-11-12",
  since: "2026-11-05T08:00:00.000Z",
  items,
  counts: {
    done: items.filter((i) => i.kind === "done").length,
    started: items.filter((i) => i.kind === "started").length,
    updated: items.filter((i) => i.kind === "updated").length,
    blocked: items.filter((i) => i.kind === "blocked").length,
  },
  said,
  dismissedCount: 0,
});

/** The answer of POST /meetings/:id/todos for a todo. */
const added = (todoId: number) => ({
  todo: { id: todoId, title: "x", status: "open" },
  project: null,
  parent: null,
  dueOn: null,
  addedAt: at,
});

describe("meeting tools", () => {
  it("list_meetings prints one line per meeting", async () => {
    const { call } = await connect(() => [
      meeting(),
      meeting({ id: 3, name: "Retro", type: "other", openCount: null, next: null }),
    ]);
    expect((await call("list_meetings")).text.split("\n")).toEqual([
      "meeting 2 | Weekly Standup | standup | every week on Thu, 09:00–09:15 | next 12.11.2026 09:00 | 2 to say",
      "meeting 3 | Retro | other | every week on Thu, 09:00–09:15 | no next date",
    ]);
  });

  it("standup_list finds the meeting by name and asks for the kinds", async () => {
    const list = standupOf([standupItem(12, "Shipped", "done", "2026-11-10T10:00:00.000Z")]);
    const { call, calls } = await connect(({ path }) => (path === "/meetings" ? [meeting()] : list));
    const { text } = await call("standup_list", { meeting: "weekly standup", kinds: ["done", "blocked"] });
    expect(calls.at(-1)).toEqual({
      method: "GET",
      path: "/meetings/2/standup",
      query: { on: undefined, kind: "done,blocked" },
    });
    expect(text).toContain("Done:\n- #12 Shipped");
    const unknown = await call("standup_list", { meeting: "Retro" });
    expect(unknown).toMatchObject({ isError: true });
    expect(unknown.text).toContain('No meeting named "Retro". The meetings:\n- 2 Weekly Standup');
  });

  it("mark_said covers each todo up to the time the list showed it and refuses todos not on it", async () => {
    const shown = standupOf([
      standupItem(12, "Shipped", "done", "2026-11-10T10:00:00.000Z"),
      standupItem(14, "Backup", "updated", "2026-11-11T08:30:00.000Z"),
    ]);
    const { call, calls } = await connect(({ method, path }) => {
      if (path === "/meetings/2") return meeting();
      if (method === "POST") return standupOf([shown.items[1] as StandupItem]);
      return shown;
    });
    const missing = await call("mark_said", { meeting: 2, todos: [12, 99] });
    expect(missing).toMatchObject({ isError: true });
    expect(missing.text).toContain("Not on the list of Weekly Standup: #99");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    const { text } = await call("mark_said", { meeting: 2, todos: [12, 12], on: "2026-11-12" });
    expect(calls.at(-1)).toEqual({
      method: "POST",
      path: "/meetings/2/standup/marks",
      body: {
        on: "2026-11-12",
        marks: [{ todoId: 12, kind: "said", coveredUntil: "2026-11-10T10:00:00.000Z" }],
      },
    });
    expect(text).toBe("Said #12 at Weekly Standup on 12.11.2026. 1 left to say.");
    await call("mark_said", { meeting: 2, todos: [14], dismiss: true });
    expect(calls.at(-1)?.body).toMatchObject({ marks: [{ todoId: 14, kind: "dismissed" }] });
    const retro = await connect(() => meeting({ type: "other" }));
    expect((await retro.call("mark_said", { meeting: 2, todos: [1] })).text).toContain("is not a standup");
  });

  it("meeting_note writes into the date's note, creating it when the date has none", async () => {
    const { call, calls } = await connect(({ method, path }) => {
      if (path === "/meetings/2") return meeting();
      if (path === "/meetings/2/notes" && method === "GET") return [];
      if (path === "/meetings/2/notes")
        return { meetingId: 2, on: "2026-11-12", note: { ...note({ id: 7 }), excerpt: "" } };
      return note({ id: 7, title: "Weekly Standup 12.11.2026" });
    });
    const { text } = await call("meeting_note", { meeting: 2, text: "Asked about the budget." });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /meetings/2",
      "GET /meetings/2/notes",
      "POST /meetings/2/notes",
      "PATCH /notes/7",
    ]);
    expect(calls.at(-1)?.body).toEqual({ appendMd: "Asked about the budget." });
    expect(text).toBe('Added to note 7 "Weekly Standup 12.11.2026" of Weekly Standup on 12.11.2026.');

    const existing = await connect(({ path }) => {
      if (path === "/meetings/2") return meeting();
      if (path === "/meetings/2/notes")
        return [{ meetingId: 2, on: "2026-11-19", note: { ...note({ id: 9 }), excerpt: "" } }];
      return note({ id: 9 });
    });
    await existing.call("meeting_note", { meeting: 2, on: "2026-11-19", text: "More" });
    expect(existing.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /meetings/2",
      "GET /meetings/2/notes",
      "PATCH /notes/9",
    ]);
  });

  it("meeting_todos lists the todos added by hand with status, due date and the next date", async () => {
    const list = {
      meetingId: 2,
      nextOn: "2026-11-12",
      items: [
        {
          todo: { id: 5, title: "Budget", status: "in_progress" },
          project: { id: 1, slug: "lab", name: "Lab", color: "#8B95A5" },
          parent: null,
          dueOn: "2026-11-12",
          addedAt: at,
        },
        {
          todo: { id: 7, title: "Cables", status: "open" },
          project: null,
          parent: { id: 3, title: "Rack", status: "open" },
          dueOn: null,
          addedAt: at,
        },
      ],
    };
    const { call, calls } = await connect(({ path }) => (path === "/meetings/2" ? meeting() : list));
    expect((await call("meeting_todos", { meeting: 2 })).text.split("\n")).toEqual([
      "Weekly Standup: 2 todos added by hand (next date 12.11.2026):",
      "- #5 Budget [Lab] | in_progress | due 12.11.2026",
      "- #7 Cables (part of #3 Rack) | open",
    ]);
    expect(calls.at(-1)).toMatchObject({ method: "GET", path: "/meetings/2/todos" });
    const empty = await connect(({ path }) =>
      path === "/meetings/2" ? meeting() : { meetingId: 2, nextOn: null, items: [] },
    );
    expect((await empty.call("meeting_todos", { meeting: 2 })).text).toBe(
      "Weekly Standup has no todos added by hand (no next date).",
    );
  });

  it("plan_meeting plans a one-time meeting with its people, from an end time or minutes", async () => {
    const anna = {
      id: 4,
      firstName: "Anna",
      lastName: "Meier",
      displayName: "Anna Meier",
      note: "",
      team: "",
      email: "",
    };
    const once = {
      ...series,
      rule: { every: "day" as const, interval: 1, basis: "schedule" as const },
      startsOn: "2026-11-13",
      endsOn: "2026-11-13",
      startTime: "14:00",
      durationMinutes: 60,
      text: "once on 13.11.2026, 14:00–15:00",
    };
    const kickOff = meeting({
      id: 5,
      name: "Kick-off",
      type: "other",
      schedule: once,
      segments: [once],
      oneTime: true,
      people: [anna],
      openCount: null,
      next: null,
    });
    const { call, calls } = await connect(() => kickOff);
    expect(
      (
        await call("plan_meeting", {
          name: "Kick-off",
          date: "2026-11-13",
          start: "14:00",
          end: "15:00",
          people: ["Anna Meier", 7],
        })
      ).text,
    ).toBe(
      "Planned meeting 5 | Kick-off | other | once on 13.11.2026, 14:00–15:00 | no next date | with Anna Meier",
    );
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/meetings",
      body: {
        name: "Kick-off",
        schedule: { startsOn: "2026-11-13", startTime: "14:00", durationMinutes: 60 },
        people: [{ firstName: "Anna", lastName: "Meier" }, { personId: 7 }],
      },
    });
    calls.length = 0;
    await call("plan_meeting", { name: "Late call", date: "2026-11-13", start: "23:30", end: "00:15" });
    expect(calls[0]?.body).toEqual({
      name: "Late call",
      schedule: { startsOn: "2026-11-13", startTime: "23:30", durationMinutes: 45 },
    });
    calls.length = 0;
    await call("plan_meeting", { name: "Sync", date: "2026-11-13", start: "10:00", minutes: 25 });
    expect(calls[0]?.body).toMatchObject({ schedule: { durationMinutes: 25 } });
    expect((await call("plan_meeting", { name: "Sync", date: "2026-11-13", start: "10:00" })).isError).toBe(
      true,
    );
  });

  it("meeting_people adds and removes people of a meeting", async () => {
    const bo = {
      id: 8,
      firstName: "Bo",
      lastName: "Berg",
      displayName: "Bo Berg",
      note: "",
      team: "",
      email: "",
    };
    const { call, calls } = await connect(({ method }) =>
      method === "PATCH" ? meeting({ people: [bo] }) : meeting(),
    );
    expect((await call("meeting_people", { meeting: 2, add: ["Bo Berg"], remove: [4] })).text).toBe(
      "Weekly Standup: with Bo Berg.",
    );
    expect(calls.at(-1)).toMatchObject({
      method: "PATCH",
      path: "/meetings/2",
      body: { addPeople: [{ firstName: "Bo", lastName: "Berg" }], removePeople: [{ personId: 4 }] },
    });
    expect((await call("meeting_people", { meeting: 2 })).isError).toBe(true);
  });

  it("add_to_meeting adds in order, sets the due date only when asked, and remove_from_meeting takes them off", async () => {
    const { call, calls } = await connect(({ method, path, body }) => {
      if (path === "/meetings/2") return meeting();
      if (path.endsWith("/due")) return todo({ dueOn: "2026-11-12" });
      if (method === "POST") return added((body as { todoId: number }).todoId);
      return undefined;
    });
    expect((await call("add_to_meeting", { meeting: 2, todos: [5, 7, 5] })).text).toBe(
      "Added #5, #7 to Weekly Standup.",
    );
    expect(calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body])).toEqual([
      ["/meetings/2/todos", { todoId: 5 }],
      ["/meetings/2/todos", { todoId: 7 }],
    ]);
    calls.length = 0;
    expect((await call("add_to_meeting", { meeting: 2, todos: [5], dueAtNext: true })).text).toBe(
      "Added #5 to Weekly Standup, due 12.11.2026.",
    );
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /meetings/2",
      "POST /meetings/2/todos",
      "POST /meetings/2/todos/5/due",
    ]);
    calls.length = 0;
    expect((await call("remove_from_meeting", { meeting: 2, todos: [5, 7] })).text).toBe(
      "Removed #5, #7 from Weekly Standup.",
    );
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual([
      "/meetings/2/todos/5",
      "/meetings/2/todos/7",
    ]);
    // Without a next date nothing is added when a due date is asked for.
    const ended = await connect(() => meeting({ next: null }));
    const refused = await ended.call("add_to_meeting", { meeting: 2, todos: [5], dueAtNext: true });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toContain("has no next date");
    expect(ended.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("list_plan shows meeting dates between the blocks, and still works without them", async () => {
    const block = {
      id: 5,
      todoId: null,
      title: "Gym",
      startAt: "2026-11-12T17:00:00.000Z",
      endAt: "2026-11-12T18:00:00.000Z",
      todo: null,
      project: null,
      createdBy: "you",
      createdAt: at,
      updatedAt: at,
    };
    const { call } = await connect(({ path }) => {
      if (path === "/blocks") return [block];
      return path === "/meetings/occurrences" ? [meeting().next] : [];
    });
    expect((await call("list_plan", { from: "2026-11-12", to: "2026-11-12" })).text.split("\n")).toEqual([
      "Plan 12.11.2026 to 12.11.2026:",
      "meeting 2 | 12.11.2026 09:00-09:15 | Weekly Standup",
      "block 5 | 12.11.2026 18:00-19:00 | Gym",
    ]);
    const older = await connect(({ path }) => {
      if (path === "/blocks") return [];
      throw new ApiError(404, "not_found", "Not found");
    });
    expect((await older.call("list_plan", { from: "2026-11-12", to: "2026-11-12" })).text).toContain(
      "Nothing planned.",
    );
  });

  it("list_plan shows the planned dates of repeating todos, moved ones with their date", async () => {
    const { call } = await connect(({ path }) => {
      if (path === "/blocks/series")
        return [
          planned("2026-11-12", "2026-11-12T09:00:00.000Z", "2026-11-12T10:00:00.000Z"),
          planned("2026-11-19", "2026-11-18T14:00:00.000Z", "2026-11-18T15:00:00.000Z", "moved"),
        ];
      return [];
    });
    expect((await call("list_plan", { from: "2026-11-12", to: "2026-11-18" })).text.split("\n")).toEqual([
      "Plan 12.11.2026 to 18.11.2026:",
      "repeat #12 | 12.11.2026 10:00-11:00 | Team report [Lab]",
      "repeat #12 | 18.11.2026 15:00-16:00 | Team report [Lab] | moved from 19.11.2026",
    ]);
  });

  it("plan_time with repeat plans the todo's repeat instead of one block", async () => {
    const { call, calls } = await connect(() => ({
      todoId: 12,
      schedule: plannedSeries,
      segments: [plannedSeries],
      next: planned("2026-11-12", "2026-11-12T09:00:00.000Z", "2026-11-12T10:00:00.000Z"),
    }));
    const result = await call("plan_time", {
      todo: 12,
      date: "2026-11-12",
      start: "10:00",
      minutes: 60,
      repeat: true,
    });
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/todos/12/plan",
        body: { startAt: "2026-11-12T09:00:00.000Z", endAt: "2026-11-12T10:00:00.000Z" },
      },
    ]);
    expect(result.text).toBe(
      "Planned #12 every week on Thu, 10:00–11:00, from 12.11.2026.\nNext: repeat #12 | 12.11.2026 10:00-11:00 | Team report [Lab]",
    );
    expect(
      (
        await call("plan_time", {
          title: "Gym",
          date: "2026-11-12",
          start: "10:00",
          minutes: 60,
          repeat: true,
        })
      ).text,
    ).toContain("repeat needs a todo");
  });

  it("list_recurring lists each repeating todo once with its next date, history and planned time", async () => {
    const { call } = await connect(() => [
      {
        todo: { id: 12, title: "Team report" },
        text: "every week on Thu",
        nextOn: "2026-11-12",
        ended: false,
        doneCount: 3,
        lastDoneAt: "2026-11-05T15:00:00.000Z",
        plan: { todoId: 12, schedule: plannedSeries, segments: [plannedSeries], next: null },
      },
      {
        todo: { id: 4, title: "Course" },
        text: "every week until 01.11.2026",
        nextOn: null,
        ended: true,
        doneCount: 1,
        lastDoneAt: "2026-10-29T15:00:00.000Z",
        plan: null,
      },
    ]);
    expect((await call("list_recurring")).text.split("\n")).toEqual([
      "#12 Team report | every week on Thu | next 12.11.2026 | done 3 times, last 05.11.2026 | planned every week on Thu, 10:00–11:00",
      "#4 Course | every week until 01.11.2026 | ended | done 1 time, last 29.10.2026",
    ]);
  });

  it("work_stats sums up worked time per project, requester and week, the last 4 weeks by default", async () => {
    const hours = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    const { call, calls } = await connect(() => ({
      from: "2026-10-15",
      to: "2026-11-11",
      totals: { workedMinutes: 270, meetingMinutes: 30, created: 3, done: 2, medianDoneMs: 2 * 86_400_000 },
      projects: [
        {
          kind: "project",
          project: { id: 1, slug: "lab", name: "Lab", color: "#4c9aff" },
          minutes: 180,
          done: 1,
        },
        { kind: "inbox", project: null, minutes: 90, done: 1 },
      ],
      requesters: [{ person: { id: 9, name: "Anna Meier" }, minutes: 120, done: 1 }],
      otherRequesters: null,
      meetingPeople: [{ person: { id: 9, name: "Anna Meier" }, minutes: 30, dates: 2 }],
      meetingMinutesWithoutPeople: 15,
      weeks: [
        { start: "2026-11-09", workedMinutes: 270, meetingMinutes: 30, created: 3, done: 2, projects: [] },
      ],
      days: [],
      hours,
      doneDurations: [],
    }));
    const text = (await call("work_stats")).text;
    expect(calls[0]).toMatchObject({
      path: "/stats/overview",
      query: { from: "2026-10-15", to: "2026-11-11" },
    });
    expect(text.split("\n")).toEqual([
      "15.10.2026 to 11.11.2026: worked 4.5 h, meetings 0.5 h, 2 done, median 2d to done, 3 created.",
      "",
      "Projects:",
      "- Lab: 3 h, 1 done",
      "- Inbox: 1.5 h, 1 done",
      "",
      "Requesters (a todo counts for each of its requesters):",
      "- Anna Meier: 2 h, 1 done",
      "",
      "Time in meetings per person (a meeting counts for each of its people):",
      "- Anna Meier: 0.5 h in 2 meetings",
      "- without people: 0.3 h",
      "",
      "Weeks:",
      "- 09.11.2026: worked 4.5 h, meetings 0.5 h, 3 created, 2 done",
    ]);
  });
});

describe("shared projects", () => {
  const space: Space = {
    id: 7,
    name: "Home move",
    color: "#4C9AFF",
    system: null,
    projectSlug: "home-move",
    openCount: 2,
    role: "owner",
    members: [
      { accountId: 1, username: "anna", name: "Anna Berg", role: "owner" },
      { accountId: 2, username: "bobo", name: "bobo", role: "member" },
    ],
    createdAt: at,
  };
  const bo = { accountId: 2, username: "bobo", name: "bobo" };
  const moveProject = { id: 1, slug: "home-move", name: "Home move", color: "#4C9AFF" };
  const van = todo({ id: 3, title: "Book van", projectId: 1, project: moveProject, assignee: bo });
  const me = { actor: "planner", via: "token", scope: "write", account: { id: 1, username: "anna" } };
  const nextOf = (items: { todo: Todo; score: number }[]) => ({
    mode: "smart",
    today: "2026-11-11",
    generatedAt: at,
    items: items.map((i) => ({ ...i, reasons: [] })),
    blocked: [],
  });

  it("list_todos adds each shared project's todos under their own heading, with S7#n and the assignee", async () => {
    const { call, calls } = await connect(({ path, space: inSpace }) => {
      if (path === "/spaces") return [space];
      if (path === "/todos") return page(inSpace === 7 ? [van] : [todo()]);
      return undefined;
    });
    const result = await call("list_todos", {});
    expect(calls.map((c) => [c.path, c.space, c.query?.assignee])).toEqual([
      ["/spaces", undefined, undefined],
      ["/todos", undefined, undefined],
      ["/todos", 7, undefined],
    ]);
    expect(result.text).toContain("1 of 1 todos:\n#142 open | Open port 443");
    expect(result.text).toContain(
      "1 of 1 todos in shared project Home move (S7):\nS7#3 open | Book van | shared Home move | assigned to bobo",
    );
  });

  it("list_todos with an assignee other than me leaves own todos out; scope own never asks the projects", async () => {
    const { call, calls } = await connect(({ path }) => (path === "/spaces" ? [space] : page([])));
    expect((await call("list_todos", { assignee: "bobo" })).text).toBe("No todos match.");
    expect(calls.map((c) => [c.path, c.space, c.query?.assignee])).toEqual([
      ["/spaces", undefined, undefined],
      ["/todos", 7, "bobo"],
    ]);
    calls.length = 0;
    await call("list_todos", { scope: "own" });
    expect(calls.map((c) => c.path)).toEqual(["/todos"]);
    calls.length = 0;
    await call("list_todos", { project: "S7", assignee: "me" });
    expect(calls.map((c) => [c.path, c.space, c.query?.assignee])).toEqual([
      ["/spaces", undefined, undefined],
      ["/todos", 7, "me"],
    ]);
  });

  it("get_todo and update_todo take S7#3, go to that project and resolve assignee me", async () => {
    const { call, calls } = await connect(({ path, method }) => {
      if (path === "/spaces/7") return space;
      if (path === "/me") return me;
      if (path === "/todos/3")
        return method === "PATCH"
          ? { ...van, assignee: { ...bo, username: "anna", name: "Anna Berg" } }
          : van;
      return undefined;
    });
    const detail = await call("get_todo", { id: "S7#3" });
    expect(detail.text).toContain("S7#3 open | Book van");
    expect(detail.text).toContain("In shared project Home move (S7)");
    expect(detail.text).toContain("Assigned to bobo (bobo).");
    const updated = await call("update_todo", { id: "s7#3", assignee: "me" });
    expect(updated.text).toContain("Updated S7#3 open | Book van | shared Home move | assigned to Anna Berg");
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch).toEqual({ method: "PATCH", path: "/todos/3", body: { assignee: "anna" }, space: 7 });
    // null clears it, without asking who "me" is.
    calls.length = 0;
    await call("update_todo", { id: "S7#3", assignee: null });
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ assignee: null });
    expect(calls.some((c) => c.path === "/me")).toBe(false);
  });

  it("says when the shared project is not one of the account's", async () => {
    const { call } = await connect(({ path }) => {
      if (path === "/spaces/9") throw new ApiError(404, "not_found", "no");
      return undefined;
    });
    const result = await call("get_todo", { id: "S9#1" });
    expect(result.isError).toBe(true);
    expect(result.text).toBe("There is no shared project S9 you are a member of. list_projects shows them.");
  });

  it("next_up ranks todos assigned to the user in shared projects in with the own ones", async () => {
    const { call, calls } = await connect(({ path, space: inSpace }) => {
      if (path === "/spaces") return [space];
      if (path === "/next")
        return inSpace === 7 ? nextOf([{ todo: van, score: 50 }]) : nextOf([{ todo: todo(), score: 20 }]);
      return undefined;
    });
    const result = await call("next_up", {});
    expect(calls.find((c) => c.space === 7)?.query?.assignee).toBe("me");
    expect(result.text).toContain(
      "1. S7#3 open | Book van | shared Home move | assigned to bobo | open 41d | score 50",
    );
    expect(result.text).toContain("2. #142 open | Open port 443");
  });

  it("create_todo in a shared project uses its project and the assignee", async () => {
    const { call, calls } = await connect(({ path, space: inSpace }) => {
      if (path === "/spaces") return [space];
      if (path === "/projects")
        return inSpace === 7 ? [{ ...homelab, id: 1, slug: "home-move", name: "Home move" }] : [homelab];
      if (path === "/todos") return van;
      return undefined;
    });
    const result = await call("create_todo", { title: "Book van", project: "Home move", assignee: "bobo" });
    expect(result.text).toBe("Created S7#3 open | Book van | shared Home move | assigned to bobo | open 41d");
    expect(calls.find((c) => c.method === "POST")).toEqual({
      method: "POST",
      path: "/todos",
      body: { title: "Book van", projectId: 1, assignee: "bobo" },
      space: 7,
    });
  });

  it("mark_done marks own and shared todos, one bulk call per place", async () => {
    const { call, calls } = await connect(({ path, space: inSpace, body }) => {
      if (path === "/spaces/7") return space;
      if (path === "/todos/bulk") {
        const ids = (body as { ids: number[] }).ids;
        return {
          updated: ids.map((id) =>
            todo(
              inSpace === 7
                ? { id, status: "done", title: "Book van", project: moveProject, assignee: bo }
                : { id, status: "done" },
            ),
          ),
        };
      }
      return undefined;
    });
    const result = await call("mark_done", { ids: [142, "S7#3", "#143"] });
    expect(
      calls.filter((c) => c.path === "/todos/bulk").map((c) => [c.space, (c.body as { ids: number[] }).ids]),
    ).toEqual([
      [undefined, [142, 143]],
      [7, [3]],
    ]);
    expect(result.text).toContain("S7#3 done | Book van");
  });

  it("search adds the todo and comment hits of each shared project", async () => {
    const hit = {
      kind: "todo",
      id: 3,
      title: "Book van",
      snippet: "Book van",
      highlights: [],
      todoId: 3,
      status: "open",
      subtitle: null,
    };
    const { call, calls } = await connect(({ path, space: inSpace }) => {
      if (path === "/spaces") return [space];
      if (path === "/search") {
        return inSpace === 7
          ? { q: "van", items: [hit], counts: { todo: 1, note: 0, comment: 0, person: 0 } }
          : { q: "van", items: [], counts: { todo: 0, note: 0, comment: 0, person: 0 } };
      }
      return undefined;
    });
    const result = await call("search", { q: "van" });
    expect(calls.find((c) => c.space === 7)?.query?.kinds).toEqual(["todo", "comment"]);
    expect(result.text).toBe(
      'Nothing found for "van".\n\nIn shared project Home move (S7):\nS7#3 open | Book van',
    );
  });

  it("list_projects lists the shared projects with their members", async () => {
    const { call } = await connect(({ path }) => (path === "/spaces" ? [space] : [homelab]));
    const result = await call("list_projects", {});
    expect(result.text).toContain(
      "S7 Home move | 2 open | you: owner | members: anna (Anna Berg, owner), bobo",
    );
  });
});
