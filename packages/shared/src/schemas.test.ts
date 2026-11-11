import { describe, expect, it } from "vitest";
import {
  BulkUpdate,
  CreatePerson,
  CreateTodo,
  ERROR_STATUS,
  ErrorBody,
  errorBody,
  IdParams,
  NextQuery,
  Todo,
  TodoListQuery,
  UpdateTodo,
} from "./index.ts";

const messages = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.error?.issues.map((i) => i.message) ?? [];

describe("CreateTodo", () => {
  it("accepts a minimal todo and trims the title", () => {
    expect(CreateTodo.parse({ title: "  Renew SSL certs " })).toEqual({ title: "Renew SSL certs" });
  });

  it("accepts people by id or by name", () => {
    const input = { title: "x", requestedBy: [{ personId: 3 }, { firstName: "Anna", lastName: "Meier" }] };
    expect(CreateTodo.parse(input)).toEqual(input);
  });

  it("rejects unknown fields, an empty title and a too long title", () => {
    expect(CreateTodo.safeParse({ title: "x", createdAt: "2026-01-01T00:00:00.000Z" }).success).toBe(false);
    expect(CreateTodo.safeParse({ title: "   " }).success).toBe(false);
    expect(CreateTodo.safeParse({ title: "x".repeat(301) }).success).toBe(false);
    expect(CreateTodo.safeParse({ title: "x".repeat(300) }).success).toBe(true);
  });

  it("rejects two labels of one scope with a message naming the scope", () => {
    const result = CreateTodo.safeParse({ title: "x", labels: ["priority::high", "priority::low"] });
    expect(result.success).toBe(false);
    expect(messages(result).join(" ")).toContain('"priority"');
  });

  it("rejects invalid dates and person refs mixing both forms", () => {
    expect(CreateTodo.safeParse({ title: "x", dueOn: "2026-02-30" }).success).toBe(false);
    expect(CreateTodo.safeParse({ title: "x", requestedBy: [{ personId: 1, firstName: "A" }] }).success).toBe(
      false,
    );
  });
});

describe("UpdateTodo", () => {
  it("needs at least one field", () => {
    expect(messages(UpdateTodo.safeParse({}))).toContain("Send at least one field to change.");
  });

  it("allows clearing dates and project with null", () => {
    expect(UpdateTodo.parse({ dueOn: null, projectId: null })).toEqual({ dueOn: null, projectId: null });
  });

  it("rejects a full label set together with add or remove", () => {
    expect(UpdateTodo.safeParse({ labels: ["a"], addLabels: ["b"] }).success).toBe(false);
    expect(UpdateTodo.safeParse({ requestedBy: [], removeRequestedBy: [{ personId: 1 }] }).success).toBe(
      false,
    );
    expect(UpdateTodo.safeParse({ addLabels: ["b"], removeLabels: ["a"] }).success).toBe(true);
  });

  it("rejects two added labels of one scope", () => {
    expect(UpdateTodo.safeParse({ addLabels: ["priority::high", "priority::low"] }).success).toBe(false);
  });
});

describe("BulkUpdate", () => {
  it("takes 1 to 200 unique ids and a non-empty patch", () => {
    const ids = Array.from({ length: 200 }, (_, i) => i + 1);
    expect(BulkUpdate.safeParse({ ids, patch: { status: "done" } }).success).toBe(true);
    expect(BulkUpdate.safeParse({ ids: [...ids, 201], patch: { status: "done" } }).success).toBe(false);
    expect(BulkUpdate.safeParse({ ids: [], patch: { status: "done" } }).success).toBe(false);
    expect(BulkUpdate.safeParse({ ids: [1, 1], patch: { status: "done" } }).success).toBe(false);
    expect(BulkUpdate.safeParse({ ids: [1], patch: {} }).success).toBe(false);
    expect(BulkUpdate.safeParse({ ids: [1], patch: { title: "no bulk titles" } }).success).toBe(false);
  });
});

describe("CreatePerson", () => {
  it("trims names and allows a duplicate flag", () => {
    expect(CreatePerson.parse({ firstName: " Anna ", lastName: "Meier", allowDuplicate: true })).toEqual({
      firstName: "Anna",
      lastName: "Meier",
      allowDuplicate: true,
    });
  });
});

describe("TodoListQuery", () => {
  it("fills the defaults", () => {
    expect(TodoListQuery.parse({})).toEqual({
      status: ["open", "in_progress", "blocked"],
      sort: "created",
      order: "desc",
      limit: 100,
      offset: 0,
    });
  });

  it("parses comma lists, inbox, numbers from strings and all", () => {
    expect(
      TodoListQuery.parse({
        status: "open,done",
        projectId: "inbox",
        label: "priority::high, homelab",
        limit: "20",
      }),
    ).toMatchObject({
      status: ["open", "done"],
      projectId: "inbox",
      label: ["priority::high", "homelab"],
      limit: 20,
    });
    expect(TodoListQuery.parse({ status: "all", projectId: "7", personId: "3" })).toMatchObject({
      status: "all",
      projectId: 7,
      personId: 3,
    });
  });

  it("rejects bad statuses, limits over 500 and unknown parameters", () => {
    expect(TodoListQuery.safeParse({ status: "open,later" }).success).toBe(false);
    expect(TodoListQuery.safeParse({ limit: "501" }).success).toBe(false);
    expect(TodoListQuery.safeParse({ limit: "0" }).success).toBe(false);
    expect(TodoListQuery.safeParse({ projectId: "-1" }).success).toBe(false);
    expect(TodoListQuery.safeParse({ colour: "red" }).success).toBe(false);
  });
});

describe("NextQuery and IdParams", () => {
  it("defaults to smart with 50 items, max 200", () => {
    expect(NextQuery.parse({})).toEqual({ mode: "smart", limit: 50 });
    expect(NextQuery.safeParse({ limit: "201" }).success).toBe(false);
    expect(NextQuery.safeParse({ mode: "random" }).success).toBe(false);
  });

  it("coerces path ids", () => {
    expect(IdParams.parse({ id: "142" })).toEqual({ id: 142 });
    expect(IdParams.safeParse({ id: "abc" }).success).toBe(false);
  });
});

describe("Todo output", () => {
  const todo = {
    id: 142,
    projectId: null,
    parentId: null,
    title: "Renew SSL certs",
    descriptionMd: "",
    status: "open",
    dueOn: "2026-11-09",
    plannedOn: null,
    position: 0,
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:00:00.000Z",
    doneAt: null,
    lastActivityAt: "2026-10-01T08:00:00.000Z",
    durationMs: null,
    labels: [],
    requestedBy: [],
    project: null,
  };

  it("accepts the documented shape and rejects extra or missing fields", () => {
    expect(Todo.parse(todo)).toEqual(todo);
    expect(Todo.safeParse({ ...todo, secret: 1 }).success).toBe(false);
    const { durationMs: _drop, ...missing } = todo;
    expect(Todo.safeParse(missing).success).toBe(false);
  });

  it("requires UTC timestamps with milliseconds", () => {
    expect(Todo.safeParse({ ...todo, createdAt: "2026-10-01T08:00:00Z" }).success).toBe(false);
    expect(Todo.safeParse({ ...todo, createdAt: "2026-10-01T08:00:00.000+01:00" }).success).toBe(false);
  });
});

describe("errors", () => {
  it("maps every code to its HTTP status and builds valid bodies", () => {
    expect(ERROR_STATUS).toEqual({
      validation_failed: 422,
      not_found: 404,
      conflict: 409,
      unauthorized: 401,
      forbidden: 403,
      unknown_host: 421,
      internal: 500,
    });
    const body = errorBody("conflict", "Ambiguous person, use personId.", { candidates: [1, 2] });
    expect(ErrorBody.parse(body)).toEqual(body);
    expect(errorBody("not_found", "Todo #9 does not exist.")).toEqual({
      error: { code: "not_found", message: "Todo #9 does not exist." },
    });
  });
});
