import type { Activity, Label, Todo } from "@organizer/shared";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { repairScopeConflicts } from "../src/services/labels.ts";
import { json, makeApp, type TestApp } from "./helpers.ts";

/** Labels "env::prod" and "stage::test", plus a todo that has both (legal: two scopes). */
async function setup(t: TestApp) {
  const env = await t.create<Label>("/api/v1/labels", { name: "env::prod" });
  const stage = await t.create<Label>("/api/v1/labels", { name: "stage::test" });
  await t.create<Label>("/api/v1/labels", { name: "homelab" });
  const both = await t.create<Todo>("/api/v1/todos", {
    title: "Both",
    labels: ["env::prod", "stage::test", "homelab"],
  });
  const only = await t.create<Todo>("/api/v1/todos", { title: "Only stage", labels: ["stage::test"] });
  return { env, stage, both, only };
}

const labelsOf = async (t: TestApp, id: number) =>
  json<Todo>(await t.call("GET", `/api/v1/todos/${id}`)).labels.map((l) => l.name);

const lastEvent = async (t: TestApp, id: number) => {
  const items = json<Activity>(await t.call("GET", `/api/v1/todos/${id}/activity`)).items;
  const last = items.at(-1);
  return last?.type === "event" ? last.event : null;
};

describe("renaming a label into another scope", () => {
  it("refuses with 409 listing the todos that would get two labels of one scope", async () => {
    const t = await makeApp();
    const { stage, both } = await setup(t);
    const res = await t.call("PATCH", `/api/v1/labels/${stage.id}`, { name: "env::test" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe(
      "Renaming would give 1 todo two scope labels. Rename with onScopeConflict replace to keep this label and remove the others.",
    );
    expect(res.json().error.details).toEqual({
      conflicts: [{ todoId: both.id, title: "Both", labels: ["env::prod", "stage::test", "homelab"] }],
    });
    // Nothing changed.
    expect(json<Label[]>(await t.call("GET", "/api/v1/labels")).map((l) => l.name)).toContain("stage::test");
    expect(await labelsOf(t, both.id)).toEqual(["env::prod", "stage::test", "homelab"]);
  });

  it("with replace keeps the renamed label, removes the others of that scope and records it", async () => {
    const t = await makeApp();
    const { stage, both, only } = await setup(t);
    t.advance(60_000);
    const res = await t.call("PATCH", `/api/v1/labels/${stage.id}`, {
      name: "ENV::test",
      onScopeConflict: "replace",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "ENV::test", scope: "ENV", value: "test" });
    expect(await labelsOf(t, both.id)).toEqual(["ENV::test", "homelab"]);
    expect(await labelsOf(t, only.id)).toEqual(["ENV::test"]);
    const event = await lastEvent(t, both.id);
    expect(event).toMatchObject({
      kind: "labels_changed",
      actor: "you",
      data: { from: ["env::prod", "stage::test", "homelab"], to: ["ENV::test", "homelab"] },
    });
    const after = json<Todo>(await t.call("GET", `/api/v1/todos/${both.id}`));
    expect(after.lastActivityAt).toBe("2026-11-11T10:01:00.000Z");
    // The todo without a conflict got no event and no activity bump.
    expect((await lastEvent(t, only.id))?.kind).toBe("created");
  });

  it("allows renames within the same scope, into a plain label and when nothing conflicts", async () => {
    const t = await makeApp();
    const { env, stage, both } = await setup(t);
    expect((await t.call("PATCH", `/api/v1/labels/${env.id}`, { name: "Env::production" })).statusCode).toBe(
      200,
    );
    expect((await t.call("PATCH", `/api/v1/labels/${stage.id}`, { name: "plain-stage" })).statusCode).toBe(
      200,
    );
    expect((await t.call("PATCH", `/api/v1/labels/${stage.id}`, { name: "other::x" })).statusCode).toBe(200);
    expect(await labelsOf(t, both.id)).toEqual(["Env::production", "other::x", "homelab"]);
  });
});

/** Puts a second label of the priority scope on a todo, as an old rename could leave it. */
async function duplicate(t: TestApp) {
  const todo = await t.create<Todo>("/api/v1/todos", {
    title: "Dup",
    labels: ["priority::low", "homelab"],
  });
  const clean = await t.create<Todo>("/api/v1/todos", { title: "Clean", labels: ["priority::high"] });
  const extra = await t.create<Label>("/api/v1/labels", { name: "priority::urgent" });
  const raw = t.deps.db.$client;
  const id = (name: string) =>
    (raw.prepare("SELECT id FROM labels WHERE name = ?").get(name) as { id: number }).id;
  raw
    .prepare("INSERT INTO todo_labels (account_id, todo_id, label_id) VALUES (?, ?, ?), (?, ?, ?)")
    .run(t.account.id, todo.id, id("priority::critical"), t.account.id, todo.id, extra.id);
  return { todo, clean };
}

describe("repairScopeConflicts", () => {
  it("keeps the lowest rank (no rank last), records it as system, and is idempotent", async () => {
    const t = await makeApp();
    await t.create<Label>("/api/v1/labels", { name: "homelab" });
    const { todo, clean } = await duplicate(t);
    expect(repairScopeConflicts(t.ctx())).toBe(1);
    expect(await labelsOf(t, todo.id)).toEqual(["priority::critical", "homelab"]);
    expect(await lastEvent(t, todo.id)).toMatchObject({
      kind: "labels_changed",
      actor: "system",
      data: {
        from: ["priority::critical", "priority::low", "priority::urgent", "homelab"],
        to: ["priority::critical", "homelab"],
      },
    });
    expect(await labelsOf(t, clean.id)).toEqual(["priority::high"]);
    expect(repairScopeConflicts(t.ctx())).toBe(0);
  });

  it("runs at every start", async () => {
    const t = await makeApp();
    await t.create<Label>("/api/v1/labels", { name: "homelab" });
    const { todo } = await duplicate(t);
    const config = t.config;
    const second = await buildApp({ config });
    await second.app.close();
    expect(await labelsOf(t, todo.id)).toEqual(["priority::critical", "homelab"]);
  });
});
