import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Activity, Comment, Note, Person, Project, Todo } from "@organizer/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type Api, ApiError } from "./api.ts";
import { registerTools } from "./tools.ts";

// The tools against a fake API: which requests they send and what they make of the answers.

const at = "2026-10-01T08:00:00.000Z";
const NOW = new Date("2026-11-11T09:00:00.000Z");

interface Call {
  method: "GET" | "POST" | "PATCH";
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

type Handler = (call: Call) => unknown;

function fakeApi(handler: Handler): { api: Api; calls: Call[] } {
  const calls: Call[] = [];
  const run = async (call: Call) => {
    calls.push(call);
    return handler(call);
  };
  const api: Api = {
    get: async (path, query) =>
      run({ method: "GET", path, query: query as Record<string, unknown> }) as never,
    post: async (path, body) => run({ method: "POST", path, body }) as never,
    patch: async (path, body) => run({ method: "PATCH", path, body }) as never,
  };
  return { api, calls };
}

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
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

  it("create_person passes team, email, topics and tags", async () => {
    const { call, calls } = await connect(() => person());
    await call("create_person", {
      firstName: "Max",
      lastName: "Muster",
      team: "Network team",
      email: "max@example.com",
      topics: ["VPN"],
      tags: ["fast reply"],
    });
    expect(calls[0]?.body).toEqual({
      firstName: "Max",
      lastName: "Muster",
      team: "Network team",
      email: "max@example.com",
      topics: ["VPN"],
      tags: ["fast reply"],
    });
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
      "#142 activity (2 items, the newest 1):\n2026-11-11 09:00 planner commented (comment 5): Asked Max.",
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

  it("update_note appends after a blank line and refuses body plus appendText", async () => {
    const { call, calls } = await connect(({ method }) =>
      method === "GET" ? note({ bodyMd: "- first\n\n" }) : note({ bodyMd: "- first\n\n- second" }),
    );
    await call("update_note", { id: 4, appendText: "- second", project: null });
    expect(calls.at(-1)).toEqual({
      method: "PATCH",
      path: "/notes/4",
      body: { bodyMd: "- first\n\n- second", projectId: null },
    });
    const both = await call("update_note", { id: 4, body: "x", appendText: "y" });
    expect(both).toEqual({
      isError: true,
      text: "Give either body (replaces the text) or appendText (adds to it), not both.",
    });
  });

  it("update_note appends to an empty note without leading blank lines", async () => {
    const { call, calls } = await connect(() => note());
    await call("update_note", { id: 4, appendText: "first" });
    expect(calls.at(-1)?.body).toEqual({ bodyMd: "first" });
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
