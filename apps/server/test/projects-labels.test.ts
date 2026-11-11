import type { Label, Project, Todo } from "@organizer/shared";
import { describe, expect, it } from "vitest";
import { events } from "../src/db/schema.ts";
import { json, makeApp } from "./helpers.ts";

describe("projects", () => {
  it("creates with a derived slug, lists with open counts, updates, archives and restores", async () => {
    const t = await makeApp();
    const p = await t.create<Project>("/api/v1/projects", { name: "Home Lab!", description: "Servers" });
    expect(p).toMatchObject({
      slug: "home-lab",
      name: "Home Lab!",
      color: "#8B95A5",
      archivedAt: null,
      openCount: 0,
    });
    const p2 = await t.create<Project>("/api/v1/projects", { name: "home lab" });
    expect(p2.slug).toBe("home-lab-2");
    await t.create("/api/v1/todos", { title: "a", projectId: p.id });
    await t.create("/api/v1/todos", { title: "b", projectId: p.id, status: "done" });
    const list = json<Project[]>(await t.call("GET", "/api/v1/projects"));
    // By name without case: "home lab" sorts before "Home Lab!".
    expect(list.map((x) => [x.slug, x.openCount])).toEqual([
      ["home-lab-2", 0],
      ["home-lab", 1],
    ]);
    t.advance(1000);
    const archived = json<Project>(
      await t.call("PATCH", `/api/v1/projects/${p.id}`, { archived: true, color: "#112233" }),
    );
    expect(archived.archivedAt).toBe("2026-11-11T10:00:01.000Z");
    expect(archived.color).toBe("#112233");
    const restored = json<Project>(await t.call("PATCH", `/api/v1/projects/${p.id}`, { archived: false }));
    expect(restored.archivedAt).toBeNull();
    expect(json<Project>(await t.call("GET", `/api/v1/projects/${p.id}`)).openCount).toBe(1);
  });

  it("answers 409 for a slug in use and 422 for a bad slug", async () => {
    const t = await makeApp();
    const p = await t.create<Project>("/api/v1/projects", { name: "A", slug: "alpha" });
    expect((await t.call("POST", "/api/v1/projects", { name: "B", slug: "alpha" })).statusCode).toBe(409);
    const other = await t.create<Project>("/api/v1/projects", { name: "B" });
    expect((await t.call("PATCH", `/api/v1/projects/${other.id}`, { slug: "alpha" })).statusCode).toBe(409);
    expect((await t.call("PATCH", `/api/v1/projects/${p.id}`, { slug: "alpha" })).statusCode).toBe(200);
    expect((await t.call("POST", "/api/v1/projects", { name: "C", slug: "Not OK" })).statusCode).toBe(422);
  });

  it("moves the todos of a deleted project to the Inbox and records it", async () => {
    const t = await makeApp();
    const p = await t.create<Project>("/api/v1/projects", { name: "Gone" });
    const todo = await t.create<Todo>("/api/v1/todos", { title: "stays", projectId: p.id });
    expect((await t.call("DELETE", `/api/v1/projects/${p.id}`)).statusCode).toBe(204);
    expect(json<Todo>(await t.call("GET", `/api/v1/todos/${todo.id}`))).toMatchObject({
      projectId: null,
      project: null,
    });
    const moved = t.deps.db
      .select()
      .from(events)
      .all()
      .filter((e) => e.kind === "project_changed");
    expect(moved.map((e) => JSON.parse(e.data))).toEqual([{ from: p.id, to: null }]);
    expect((await t.call("GET", `/api/v1/projects/${p.id}`)).statusCode).toBe(404);
    expect((await t.call("DELETE", `/api/v1/projects/${p.id}`)).statusCode).toBe(404);
  });
});

describe("labels", () => {
  it("starts with the four priority labels in rank order", async () => {
    const t = await makeApp();
    const labels = json<Label[]>(await t.call("GET", "/api/v1/labels"));
    expect(labels.map((l) => [l.name, l.color, l.rank])).toEqual([
      ["priority::critical", "#F2555A", 0],
      ["priority::high", "#FFB224", 1],
      ["priority::medium", "#9AA4B2", 2],
      ["priority::low", "#5B6573", 3],
    ]);
  });

  it("creates scoped and plain labels, splitting on the last ::", async () => {
    const t = await makeApp();
    const nested = await t.create<Label>("/api/v1/labels", { name: "env::prod::eu", color: "#123456" });
    expect(nested).toMatchObject({ scope: "env::prod", value: "eu", color: "#123456", rank: null });
    const plain = await t.create<Label>("/api/v1/labels", { name: "homelab" });
    expect(plain).toMatchObject({ scope: null, value: "homelab", color: "#8B95A5" });
    expect((await t.call("POST", "/api/v1/labels", { name: "HomeLab" })).statusCode).toBe(409);
    expect((await t.call("POST", "/api/v1/labels", { name: "a,b" })).statusCode).toBe(422);
    expect((await t.call("POST", "/api/v1/labels", { name: "::x" })).statusCode).toBe(422);
  });

  it("renames (scope follows the name), and deletes a label from every todo", async () => {
    const t = await makeApp();
    const label = await t.create<Label>("/api/v1/labels", { name: "homelab" });
    const todo = await t.create<Todo>("/api/v1/todos", { title: "x", labels: ["homelab", "priority::high"] });
    const renamed = json<Label>(
      await t.call("PATCH", `/api/v1/labels/${label.id}`, { name: "area::homelab" }),
    );
    expect(renamed).toMatchObject({ scope: "area", value: "homelab" });
    expect((await t.call("PATCH", `/api/v1/labels/${label.id}`, { name: "priority::high" })).statusCode).toBe(
      409,
    );
    expect((await t.call("DELETE", `/api/v1/labels/${label.id}`)).statusCode).toBe(204);
    expect(json<Todo>(await t.call("GET", `/api/v1/todos/${todo.id}`)).labels.map((l) => l.name)).toEqual([
      "priority::high",
    ]);
    expect((await t.call("DELETE", `/api/v1/labels/${label.id}`)).statusCode).toBe(404);
  });
});
