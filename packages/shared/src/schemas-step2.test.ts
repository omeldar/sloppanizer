import { describe, expect, it } from "vitest";
import {
  ActivityItem,
  Attachment,
  CreateComment,
  CreateNote,
  CreatePerson,
  CreatePersonTag,
  NoteListQuery,
  NoteSummary,
  PeopleQuery,
  Person,
  PersonBrief,
  SearchQuery,
  TodoListQuery,
  TopicQuery,
  UpdateNote,
  UpdatePerson,
  UpdatePersonTag,
  UpdateTodo,
  UpdateTopic,
} from "./index.ts";

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe("contacts on todos", () => {
  it("rejects a full contact set together with add or remove", () => {
    expect(ok(UpdateTodo, { contacts: [{ personId: 1 }] })).toBe(true);
    expect(ok(UpdateTodo, { addContacts: [{ personId: 1 }], removeContacts: [{ personId: 2 }] })).toBe(true);
    expect(ok(UpdateTodo, { contacts: [], addContacts: [{ personId: 1 }] })).toBe(false);
    expect(ok(UpdateTodo, { contacts: [], removeContacts: [{ firstName: "A", lastName: "B" }] })).toBe(false);
  });
});

describe("TodoListQuery step 2 fields", () => {
  it("defaults personRole to requester and accepts contact and any", () => {
    expect(TodoListQuery.parse({ personId: "3" })).toMatchObject({ personId: 3, personRole: "requester" });
    expect(TodoListQuery.parse({ personRole: "contact" }).personRole).toBe("contact");
    expect(TodoListQuery.parse({ personRole: "any" }).personRole).toBe("any");
    expect(ok(TodoListQuery, { personRole: "owner" })).toBe(false);
  });

  it("parses planned ranges, unplanned and doneAfter", () => {
    expect(
      TodoListQuery.parse({ plannedFrom: "2026-11-09", plannedTo: "2026-11-15", doneAfter: "2026-10-29" }),
    ).toMatchObject({ plannedFrom: "2026-11-09", plannedTo: "2026-11-15", doneAfter: "2026-10-29" });
    expect(TodoListQuery.parse({ unplanned: "true" }).unplanned).toBe(true);
    expect(TodoListQuery.parse({ unplanned: "false" }).unplanned).toBe(false);
    expect(ok(TodoListQuery, { unplanned: "yes" })).toBe(false);
    expect(ok(TodoListQuery, { plannedFrom: "2026-13-01" })).toBe(false);
  });

  it("rejects unplanned=true with a planned range", () => {
    expect(ok(TodoListQuery, { unplanned: "true", plannedFrom: "2026-11-09" })).toBe(false);
    expect(ok(TodoListQuery, { unplanned: "true", plannedTo: "2026-11-09" })).toBe(false);
    expect(ok(TodoListQuery, { unplanned: "false", plannedTo: "2026-11-09" })).toBe(true);
  });
});

describe("person inputs", () => {
  it("accepts the new fields and normalizes topics", () => {
    expect(
      CreatePerson.parse({
        firstName: "Max",
        lastName: "Muster",
        team: " Network team ",
        email: "max@example.com",
        notesMd: "# Max",
        topics: ["  firewall   rules ", "VPN"],
        tags: [" fast reply "],
      }),
    ).toEqual({
      firstName: "Max",
      lastName: "Muster",
      team: "Network team",
      email: "max@example.com",
      notesMd: "# Max",
      topics: ["firewall rules", "VPN"],
      tags: ["fast reply"],
    });
  });

  it("takes an email or an empty text, nothing else", () => {
    expect(ok(CreatePerson, { firstName: "A", lastName: "B", email: "" })).toBe(true);
    expect(ok(CreatePerson, { firstName: "A", lastName: "B", email: "not an email" })).toBe(false);
    expect(ok(CreatePerson, { firstName: "A", lastName: "B", email: `${"a".repeat(250)}@b.ch` })).toBe(false);
  });

  it("enforces the limits", () => {
    const base = { firstName: "A", lastName: "B" };
    expect(ok(CreatePerson, { ...base, team: "t".repeat(100) })).toBe(true);
    expect(ok(CreatePerson, { ...base, team: "t".repeat(101) })).toBe(false);
    expect(ok(CreatePerson, { ...base, topics: ["x".repeat(61)] })).toBe(false);
    expect(ok(CreatePerson, { ...base, topics: ["   "] })).toBe(false);
    expect(ok(CreatePerson, { ...base, topics: ["a,b"] })).toBe(false);
    expect(ok(CreatePerson, { ...base, topics: Array.from({ length: 51 }, (_, i) => `t${i}`) })).toBe(false);
    expect(ok(CreatePerson, { ...base, tags: Array.from({ length: 31 }, (_, i) => `t${i}`) })).toBe(false);
    expect(ok(CreatePerson, { ...base, tags: ["team::fast"] })).toBe(false);
    expect(ok(CreatePerson, { ...base, notesMd: "x".repeat(200_001) })).toBe(false);
  });

  it("rejects full sets together with add or remove, and an empty patch", () => {
    expect(ok(UpdatePerson, { topics: ["a"], addTopics: ["b"] })).toBe(false);
    expect(ok(UpdatePerson, { tags: [], removeTags: ["b"] })).toBe(false);
    expect(ok(UpdatePerson, { addTopics: ["a"], removeTopics: ["b"], addTags: ["c"] })).toBe(true);
    expect(ok(UpdatePerson, {})).toBe(false);
    expect(ok(UpdatePerson, { email: "" })).toBe(true);
  });

  it("validates person tags and topic renames", () => {
    expect(CreatePersonTag.parse({ name: " fast reply ", color: "#22AA66" })).toEqual({
      name: "fast reply",
      color: "#22AA66",
    });
    expect(ok(CreatePersonTag, { name: "x", color: "green" })).toBe(false);
    expect(ok(UpdatePersonTag, {})).toBe(false);
    expect(UpdateTopic.parse({ name: " SAP   access " })).toEqual({ name: "SAP access" });
    expect(ok(UpdateTopic, { name: "" })).toBe(false);
  });
});

describe("comments and notes", () => {
  it("needs a comment with real text, stored as sent", () => {
    expect(CreateComment.parse({ bodyMd: "  done  \n" })).toEqual({ bodyMd: "  done  \n" });
    expect(ok(CreateComment, { bodyMd: " \n " })).toBe(false);
    expect(ok(CreateComment, { bodyMd: "x".repeat(50_001) })).toBe(false);
    expect(ok(CreateComment, { bodyMd: "x".repeat(50_000) })).toBe(true);
  });

  it("validates notes", () => {
    expect(CreateNote.parse({ title: " Ideas ", pinned: true, projectId: null })).toEqual({
      title: "Ideas",
      pinned: true,
      projectId: null,
    });
    expect(ok(CreateNote, { title: "x".repeat(201) })).toBe(false);
    expect(ok(CreateNote, { title: "x", bodyMd: "x".repeat(200_001) })).toBe(false);
    expect(ok(UpdateNote, {})).toBe(false);
    expect(ok(UpdateNote, { pinned: false })).toBe(true);
  });
});

describe("list and search queries", () => {
  it("parses people filters", () => {
    expect(PeopleQuery.parse({})).toEqual({ sort: "name" });
    expect(
      PeopleQuery.parse({ topic: "firewall  rules,VPN", tag: "fast reply", kind: "contact", sort: "recent" }),
    ).toEqual({ topic: ["firewall rules", "VPN"], tag: ["fast reply"], kind: "contact", sort: "recent" });
    expect(ok(PeopleQuery, { kind: "boss" })).toBe(false);
    expect(ok(PeopleQuery, { sort: "age" })).toBe(false);
  });

  it("parses note filters", () => {
    expect(NoteListQuery.parse({})).toEqual({ limit: 100, offset: 0 });
    expect(NoteListQuery.parse({ projectId: "none", pinned: "true" })).toMatchObject({
      projectId: "none",
      pinned: true,
    });
    expect(NoteListQuery.parse({ projectId: "4" }).projectId).toBe(4);
    expect(ok(NoteListQuery, { limit: "501" })).toBe(false);
  });

  it("requires a search text and defaults to all kinds", () => {
    expect(SearchQuery.parse({ q: " vpn " })).toEqual({
      q: "vpn",
      kinds: ["todo", "note", "comment", "person"],
      limit: 20,
    });
    expect(SearchQuery.parse({ q: "x", kinds: "note,person", limit: "5" })).toMatchObject({
      kinds: ["note", "person"],
      limit: 5,
    });
    expect(ok(SearchQuery, {})).toBe(false);
    expect(ok(SearchQuery, { q: "   " })).toBe(false);
    expect(ok(SearchQuery, { q: "x".repeat(201) })).toBe(false);
    expect(ok(SearchQuery, { q: "x", kinds: "label" })).toBe(false);
    expect(ok(SearchQuery, { q: "x", kinds: "," })).toBe(false);
    expect(ok(SearchQuery, { q: "x", limit: "101" })).toBe(false);
    expect(TopicQuery.parse({})).toEqual({ limit: 20 });
  });
});

describe("outputs", () => {
  const brief = {
    id: 1,
    firstName: "Max",
    lastName: "Muster",
    displayName: "Max Muster",
    note: "",
    team: "Network",
    email: "",
  };

  it("keeps tags, topics and notes out of PersonBrief", () => {
    expect(PersonBrief.parse(brief)).toEqual(brief);
    expect(ok(PersonBrief, { ...brief, topics: [] })).toBe(false);
    expect(ok(PersonBrief, { ...brief, notesMd: "" })).toBe(false);
  });

  it("needs counts, topics and tags on the full Person", () => {
    const person = {
      ...brief,
      notesMd: "",
      topics: ["VPN"],
      tags: [],
      counts: { requested: 1, requestedOpen: 1, requestedDone: 0, contact: 0, contactOpen: 0 },
      createdAt: "2026-11-12T10:00:00.000Z",
      updatedAt: "2026-11-12T10:00:00.000Z",
    };
    expect(Person.parse(person)).toEqual(person);
    const { counts: _counts, ...noCounts } = person;
    expect(ok(Person, noCounts)).toBe(false);
  });

  it("discriminates activity items on type", () => {
    const comment = {
      id: 1,
      todoId: 2,
      actor: "you",
      bodyMd: "hi",
      createdAt: "2026-11-12T10:00:00.000Z",
      updatedAt: "2026-11-12T10:00:00.000Z",
      editedAt: null,
    };
    expect(ok(ActivityItem, { type: "comment", comment })).toBe(true);
    expect(ok(ActivityItem, { type: "event", comment })).toBe(false);
    expect(
      ok(ActivityItem, {
        type: "event",
        event: { id: 1, todoId: 2, actor: "you", kind: "renamed", data: {}, createdAt: comment.createdAt },
      }),
    ).toBe(false);
  });

  it("keeps NoteSummary strict and without the body", () => {
    const summary = {
      id: 1,
      projectId: null,
      project: null,
      title: "Ideas",
      excerpt: "first words",
      pinnedAt: null,
      createdBy: "you",
      createdAt: "2026-11-12T10:00:00.000Z",
      updatedAt: "2026-11-12T10:00:00.000Z",
    };
    expect(NoteSummary.parse(summary)).toEqual(summary);
    expect(ok(NoteSummary, { ...summary, bodyMd: "" })).toBe(false);
  });

  it("describes attachments", () => {
    expect(
      ok(Attachment, {
        id: 1,
        name: "shot.png",
        mimeType: "image/png",
        size: 10,
        sha256: "ab",
        url: "/api/v1/attachments/1/shot.png",
        inline: true,
        createdBy: "you",
        createdAt: "2026-11-12T10:00:00.000Z",
      }),
    ).toBe(true);
  });
});
