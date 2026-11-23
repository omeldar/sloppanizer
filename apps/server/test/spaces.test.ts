import type { Space, Todo, TodoPage } from "@organizer/shared";
import { describe, expect, it } from "vitest";
import { json, makeApp } from "./helpers.ts";

const H = "x-sloppanizer-space";

describe("feedback", () => {
  it("lands in the Sloppanizer project, which every admin (and only admins) can open", async () => {
    const t = await makeApp();
    const admin = await t.asAccount({ username: "root", role: "admin" });
    const other = await t.asAccount({ username: "carla", role: "admin" });
    await t.call("PATCH", "/api/v1/account", { firstName: "Anna", lastName: "Berg" });

    const sent = await t.call("POST", "/api/v1/feedback", {
      kind: "bug",
      title: "Board drops cards",
      description: "Dragging to Done loses it.",
      page: "/board",
    });
    expect(sent.statusCode).toBe(201);
    const { id } = json<{ id: number }>(sent);
    // A user without a name shows up by username.
    await admin.create("/api/v1/feedback", { kind: "feature", title: "Dark planner" });

    // Users do not see the project, admins do.
    expect(json<Space[]>(await t.call("GET", "/api/v1/spaces"))).toEqual([]);
    const [space] = json<Space[]>(await admin.call("GET", "/api/v1/spaces"));
    expect(space).toMatchObject({
      system: "feedback",
      name: "Sloppanizer",
      projectSlug: "sloppanizer",
      openCount: 2,
    });
    expect(space?.members.map((m) => m.username)).toEqual(["carla", "root"]);
    const spaceId = String(space?.id);
    expect((await t.call("GET", "/api/v1/todos", undefined, { [H]: spaceId })).statusCode).toBe(404);

    const todo = json<Todo>(await admin.call("GET", `/api/v1/todos/${id}`, undefined, { [H]: spaceId }));
    expect(todo.title).toBe("Board drops cards");
    expect(todo.labels.map((l) => l.name)).toEqual(["type::bug"]);
    expect(todo.requestedBy.map((p) => `${p.firstName} ${p.lastName}`.trim())).toEqual(["Anna Berg"]);
    expect(todo.descriptionMd).toContain("Dragging to Done loses it.");
    expect(todo.descriptionMd).toContain("@anna");
    const page = json<TodoPage>(
      await other.call("GET", "/api/v1/todos?sort=created", undefined, { [H]: spaceId }),
    );
    const feature = page.items.find((i) => i.title === "Dark planner");
    expect(feature?.requestedBy.map((p) => p.firstName)).toEqual(["root"]);

    // Works like any todo: plan it, change it, delete it. The history names the admin.
    const changed = await other.call(
      "PATCH",
      `/api/v1/todos/${id}`,
      { plannedOn: "2026-11-12", status: "in_progress" },
      { [H]: spaceId },
    );
    expect(changed.statusCode).toBe(200);
    const block = await other.call(
      "POST",
      "/api/v1/blocks",
      { todoId: id, startAt: "2026-11-12T09:00:00.000Z", endAt: "2026-11-12T10:00:00.000Z" },
      { [H]: spaceId },
    );
    expect(block.statusCode).toBe(201);
    const activity = json<{ items: { type: string; event?: { actor: string } }[] }>(
      await other.call("GET", `/api/v1/todos/${id}/activity`, undefined, { [H]: spaceId }),
    );
    expect(activity.items.some((i) => i.event?.actor === "carla")).toBe(true);
    expect((await other.call("DELETE", `/api/v1/todos/${id}`, undefined, { [H]: spaceId })).statusCode).toBe(
      204,
    );

    // The admin's own data is untouched.
    expect(json<TodoPage>(await admin.call("GET", "/api/v1/todos")).items).toEqual([]);
    // Personal routes stay personal, and the project cannot be deleted.
    expect((await admin.call("GET", "/api/v1/tokens", undefined, { [H]: spaceId })).statusCode).toBe(403);
    expect((await admin.call("DELETE", `/api/v1/spaces/${spaceId}`)).statusCode).toBe(409);
    // Space accounts are not listed for admins.
    const accounts = json<{ username: string }[]>(await admin.call("GET", "/api/v1/admin/accounts"));
    expect(accounts.every((a) => !a.username.startsWith("~"))).toBe(true);
  });
});

describe("shared projects", () => {
  it("members work in it, others cannot, owners manage members", async () => {
    const t = await makeApp();
    const bo = await t.asAccount({ username: "bobo" });
    const cy = await t.asAccount({ username: "cyra" });
    const space = await t.create<Space>("/api/v1/spaces", { name: "Home move", members: ["bobo"] });
    expect(space.role).toBe("owner");
    expect(space.members.map((m) => [m.username, m.role])).toEqual([
      ["anna", "owner"],
      ["bobo", "member"],
    ]);
    const id = String(space.id);
    const [project] = json<{ id: number }[]>(
      await bo.call("GET", "/api/v1/projects", undefined, { [H]: id }),
    );
    const todo = await bo.call(
      "POST",
      "/api/v1/todos",
      { title: "Book van", projectId: project?.id },
      { [H]: id },
    );
    expect(todo.statusCode).toBe(201);
    expect((await t.call("GET", "/api/v1/todos", undefined, { [H]: id })).statusCode).toBe(200);
    expect((await cy.call("GET", "/api/v1/todos", undefined, { [H]: id })).statusCode).toBe(404);

    // Members cannot manage, owners can; tokens never enter a space.
    expect((await bo.call("POST", `/api/v1/spaces/${id}/members`, { username: "cyra" })).statusCode).toBe(
      403,
    );
    expect((await t.call("POST", `/api/v1/spaces/${id}/members`, { username: "cyra" })).statusCode).toBe(200);
    expect((await cy.call("GET", "/api/v1/todos", undefined, { [H]: id })).statusCode).toBe(200);
    const raw = t.token("script", "write");
    const viaToken = await t.app.inject({
      method: "GET",
      url: "/api/v1/todos",
      headers: { authorization: `Bearer ${raw}`, [H]: id },
    });
    expect(viaToken.statusCode).toBe(403);

    // Leaving, and the last owner deleting it.
    expect((await bo.call("DELETE", `/api/v1/spaces/${id}/members/${bo.account.id}`)).statusCode).toBe(204);
    expect((await bo.call("GET", "/api/v1/todos", undefined, { [H]: id })).statusCode).toBe(404);
    expect((await t.call("PATCH", `/api/v1/spaces/${id}`, { name: "New flat" })).statusCode).toBe(200);
    expect((await t.call("DELETE", `/api/v1/spaces/${id}`)).statusCode).toBe(204);
    expect(json<Space[]>(await cy.call("GET", "/api/v1/spaces"))).toEqual([]);
  });
});

describe("date and time formats", () => {
  it("are part of the profile and can be changed", async () => {
    const t = await makeApp();
    const before = json<{ dateFormat: string; timeFormat: string }>(await t.call("GET", "/api/v1/account"));
    expect(before).toMatchObject({ dateFormat: "dmy.", timeFormat: "24h" });
    const after = await t.call("PATCH", "/api/v1/account", { dateFormat: "mdy/", timeFormat: "12h" });
    expect(json(after)).toMatchObject({ dateFormat: "mdy/", timeFormat: "12h" });
    expect((await t.call("PATCH", "/api/v1/account", { dateFormat: "nope" })).statusCode).toBe(422);
  });
});
