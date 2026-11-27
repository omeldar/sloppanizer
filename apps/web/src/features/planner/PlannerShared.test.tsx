import type { Space, TimeBlock } from "@organizer/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { headersOf, makeTodo, type RecordedCall } from "../../test/render.tsx";
import { renderAppAt } from "../../test/renderApp.tsx";

await import("./PlannerPage.tsx");

// Todos of shared projects in your own tab's planner (S5#13): your time there, the Day row, To plan.

const T = "2026-11-18T09:00:00.000Z";
const H = "x-sloppanizer-space";
const space: Space = {
  id: 7,
  name: "Home move",
  color: "#4C9AFF",
  system: null,
  projectSlug: "home-move",
  openCount: 3,
  role: "member",
  members: [],
  createdAt: T,
};
const ref = { id: 7, name: "Home move", color: "#4C9AFF" };
const anna = { accountId: 1, username: "anna", name: "Anna" };
const ana = { accountId: 2, username: "ana", name: "Ana Bell" };

/** Your time on S7#3, as your own planner lists it (with its project). */
const vanTime: TimeBlock = {
  id: 5,
  todoId: 3,
  title: "",
  startAt: "2026-11-19T12:00:00.000Z",
  endAt: "2026-11-19T13:00:00.000Z",
  todo: { id: 3, title: "Book van", status: "open" },
  project: null,
  createdBy: "Anna",
  createdAt: T,
  updatedAt: T,
  space: ref,
  member: anna,
  assignee: anna,
};
const boxes = makeTodo({ id: 4, title: "Pack boxes", assignee: anna });
const keys = makeTodo({ id: 8, title: "Return keys", plannedOn: "2026-11-20", assignee: anna });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-19T06:00:00.000Z"));
  Element.prototype.setPointerCapture ??= () => {};
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const emptyPage = { items: [], total: 0, limit: 200, offset: 0 };
const nextOf = (items: { todo: typeof boxes; score: number }[]) => ({
  mode: "smart",
  today: "2026-11-19",
  generatedAt: T,
  items: items.map((i) => ({ ...i, reasons: [] })),
  blocked: [],
});

function renderPlanner() {
  return renderAppAt("/planner?day=2026-11-19", (call: RecordedCall) => {
    const path = call.path.split("?")[0];
    const inSpace = headersOf(call)[H] === "7";
    if (path === "/api/v1/spaces") return { body: [space] };
    if (path === "/api/v1/blocks" && call.method === "POST")
      return { status: 201, body: { ...vanTime, id: 6, todoId: 4, assignee: ana, space: null } };
    if (path === "/api/v1/blocks") return { body: [vanTime] };
    if (path?.startsWith("/api/v1/blocks/")) return { body: vanTime };
    if (path === "/api/v1/meetings/occurrences" || path === "/api/v1/meetings") return { body: [] };
    if (path === "/api/v1/todos")
      return { body: inSpace ? { items: [keys], total: 1, limit: 200, offset: 0 } : emptyPage };
    if (path === "/api/v1/next") return { body: nextOf(inSpace ? [{ todo: boxes, score: 30 }] : []) };
    return { status: 404, body: { error: { code: "not_found", message: "Not here." } } };
  });
}

describe("shared projects in your own planner", () => {
  it("asks for your time in shared projects and shows it with its project", async () => {
    const { calls } = renderPlanner();
    const card = await screen.findByTitle(/^Book van \(Home move\), /, {}, { timeout: 5000 });
    expect(within(card).getByText("Home move")).toBeTruthy();
    const asked = calls.find((c) => c.path.startsWith("/api/v1/blocks?"));
    expect(asked?.path).toContain("shared=true");
    expect(asked && headersOf(asked)[H]).toBeUndefined();
    // The planned day of a todo assigned to you there is asked for in that project, with assignee=me.
    const days = calls.find((c) => c.path.startsWith("/api/v1/todos?") && headersOf(c)[H] === "7");
    expect(days?.path).toContain("assignee=me");
  });

  it("moves your time in a shared project inside that project", async () => {
    const { calls } = renderPlanner();
    const card = await screen.findByTitle(/^Book van \(Home move\), /, {}, { timeout: 5000 });
    const at = { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100 };
    fireEvent.pointerDown(card, { ...at, clientY: 200 });
    fireEvent.pointerMove(card, { ...at, clientY: 226 });
    fireEvent.pointerMove(card, { ...at, clientY: 252 });
    fireEvent.pointerUp(card, { ...at, clientY: 252 });
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.path).toBe("/api/v1/blocks/5");
    expect(patch && headersOf(patch)[H]).toBe("7");
  });

  it("lists shared todos in the Day row and To plan, and plans them in their project", async () => {
    const { calls } = renderPlanner();
    const side = await screen.findByRole("complementary", { name: "To plan" });
    const item = await within(side).findByRole("button", { name: /Pack boxes/ }, { timeout: 5000 });
    expect(within(item).getByText("Home move")).toBeTruthy();
    const day = await screen.findByLabelText("Planned for the day, no time yet");
    expect(within(day).getByRole("button", { name: /Return keys/ })).toBeTruthy();

    fireEvent.click(item);
    const dialog = await screen.findByRole("dialog", { name: "Plan time" });
    expect(within(dialog).getByText("Pack boxes")).toBeTruthy();
    // Planned time that repeats is for your own todos.
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Plan" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST");
    expect(post).toMatchObject({ path: "/api/v1/blocks", body: { todoId: 4 } });
    expect(post && headersOf(post)[H]).toBe("7");
    // Somebody else is on it: it stays theirs, and the toast says so.
    expect(await screen.findByText("Planned Pack boxes; it stays assigned to Ana Bell")).toBeTruthy();
  });
});
