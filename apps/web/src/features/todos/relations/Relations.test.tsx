import type { Todo } from "@organizer/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandsProvider } from "../../../app/commands.tsx";
import { routeTree } from "../../../app/router.tsx";
import { ToastProvider } from "../../../components/toast/ToastProvider.tsx";
import { KeyboardProvider } from "../../../keyboard/KeyboardProvider.tsx";
import { makeMe, makeTodo, mockApi } from "../../../test/render.tsx";
import { pastedTitles } from "./SubtaskInput.tsx";
import { stepTarget } from "./Subtasks.tsx";

// The route loads this page lazily. Loading it here, with the test file, keeps the import (and the
// editor) out of the first test's time limit.
await import("../TodoPage.tsx");

const LAZY_PAGE = { timeout: 5000 };

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

const parent = makeTodo({
  id: 1,
  title: "Move the rack",
  progress: { subtasks: { total: 2, done: 0 }, checklist: { total: 0, done: 0 } },
  links: { blocks: [], blockedBy: [{ id: 9, title: "Order the switch", status: "open" }], relatesTo: [] },
});
const first = makeTodo({ id: 2, title: "Measure the corner", parentId: 1, position: 0 });
const second = makeTodo({ id: 3, title: "Book the van", parentId: 1, position: 1 });
const other = makeTodo({ id: 5, title: "Label the cables" });

function renderParent(overrides: Partial<Todo> = {}) {
  const shown = { ...parent, ...overrides };
  const calls = mockApi(({ method, path, body }) => {
    if (method === "GET" && path === "/api/v1/todos/1") return { body: shown };
    if (method === "GET" && path === "/api/v1/todos/5") return { body: other };
    if (method === "GET" && path.startsWith("/api/v1/todos?") && path.includes("parentId=1")) {
      return { body: { items: [first, second], total: 2, limit: 200, offset: 0 } };
    }
    if (path === "/api/v1/todos/1/activity") return { body: { todoId: 1, items: [] } };
    if (path === "/api/v1/me") return { body: makeMe() };
    if (path === "/api/v1/projects" || path === "/api/v1/labels") return { body: [] };
    if (method === "POST" && path === "/api/v1/todos/1/subtasks") return { status: 201, body: [] };
    if (method === "POST" && path === "/api/v1/todos/bulk") return { body: { updated: [] } };
    if (method === "POST" && path === "/api/v1/todos/1/links") return { body: parent };
    if (method === "PATCH") {
      const id = Number(path.split("/").pop());
      const base = [parent, first, second].find((t) => t.id === id) ?? parent;
      return { body: { ...base, ...(body as Partial<Todo>) } };
    }
    return { status: 404, body: { error: { code: "not_found", message: "Not here." } } };
  });
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ["/todos/1"] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <KeyboardProvider>
        <ToastProvider>
          <CommandsProvider>
            <RouterProvider router={router} />
          </CommandsProvider>
        </ToastProvider>
      </KeyboardProvider>
    </QueryClientProvider>,
  );
  return calls;
}

/** Holds every PATCH until `open()`, so a test can look at the page before the server answered. */
const gate = {
  open: () => {},
};

/** The parent page with these children; the list answers with the patched positions once they are saved. */
function mockChildren(children: Todo[]) {
  const positions = new Map(children.map((c) => [c.id, c.position]));
  let opened!: () => void;
  const opening = new Promise<void>((resolve) => {
    opened = resolve;
  });
  gate.open = opened;
  const calls = renderParent();
  const answer = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      calls.push({ method: "PATCH", path: input, body: JSON.parse(String(init.body)) });
      await opening;
      const id = Number(input.split("/").pop());
      const { position } = JSON.parse(String(init.body)) as { position: number };
      positions.set(id, position);
      const child = children.find((c) => c.id === id);
      return new Response(JSON.stringify({ ...child, position }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (input.startsWith("/api/v1/todos?") && input.includes("parentId=1")) {
      calls.push({ method: "GET", path: input, body: undefined });
      const items = children
        .map((c) => ({ ...c, position: positions.get(c.id) ?? c.position }))
        .toSorted((a, b) => a.position - b.position || a.id - b.id);
      return new Response(JSON.stringify({ items, total: items.length, limit: 200, offset: 0 }), {
        headers: { "content-type": "application/json" },
      });
    }
    return answer(input, init);
  });
  return calls;
}

describe("subtasks and links on the todo page", () => {
  it("shows the open blocker, the progress and the children in order", async () => {
    renderParent();
    const waiting = await screen.findByRole("note", {}, LAZY_PAGE);
    expect(waiting.textContent).toBe("Waiting on #9 Order the switch");
    expect(screen.getByText("0 of 2 done")).toBeTruthy();
    const rows = await screen.findByRole("list", { name: "Subtasks in order" });
    expect(
      within(rows)
        .getAllByRole("link")
        .map((r) => r.textContent),
    ).toEqual(["Measure the corner", "Book the van"]);
    // The row has no label of its own that would hide its checkbox and link from screen readers.
    expect(within(rows).getAllByRole("listitem")[0]?.hasAttribute("aria-label")).toBe(false);
    expect(within(rows).getByRole("checkbox", { name: "Mark #2 done" })).toBeTruthy();
  });

  it("adds a subtask with Enter and several from pasted lines after a confirm", async () => {
    const user = userEvent.setup();
    const calls = renderParent();
    const input = await screen.findByRole("textbox", { name: "Add subtask" }, LAZY_PAGE);
    await user.type(input, "Buy cables{Enter}");
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith("/subtasks"))).toHaveLength(1));
    expect(calls.find((c) => c.path.endsWith("/subtasks"))?.body).toEqual({ titles: ["Buy cables"] });

    fireEvent.paste(input, { clipboardData: { getData: () => "- [ ] Unplug\n\n- Carry\n3. Plug in" } });
    const ask = await screen.findByText("Add 3 subtasks, one per line?");
    expect(calls.filter((c) => c.path.endsWith("/subtasks"))).toHaveLength(1);
    await user.click(within(ask.parentElement as HTMLElement).getByRole("button", { name: "Add 3" }));
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith("/subtasks"))).toHaveLength(2));
    expect(calls.filter((c) => c.path.endsWith("/subtasks"))[1]?.body).toEqual({
      titles: ["Unplug", "Carry", "Plug in"],
    });
  });

  it("moves the focused subtask down with alt+j", async () => {
    const calls = renderParent();
    const rows = await screen.findByRole("list", { name: "Subtasks in order" }, LAZY_PAGE);
    act(() => within(rows).getByRole("checkbox", { name: "Mark #2 done" }).focus());
    fireEvent.keyDown(window, { key: "j", altKey: true });
    await waitFor(() =>
      expect(calls.some((c) => c.method === "PATCH" && c.path === "/api/v1/todos/2")).toBe(true),
    );
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ position: 2 });
  });

  it("shows the new order at once and refreshes the list once for a move that patches two rows", async () => {
    // Every todo starts at position 0, so moving #2 below #3 also moves #3 up: two patches.
    const flat = [2, 3, 4].map((id) =>
      makeTodo({ id, title: `Step ${id}`, parentId: 1, position: 0, status: "open" }),
    );
    const calls = mockChildren(flat);
    const rows = await screen.findByRole("list", { name: "Subtasks in order" }, LAZY_PAGE);
    const titles = () =>
      within(rows)
        .getAllByRole("link")
        .map((r) => r.textContent);
    await waitFor(() => expect(titles()).toEqual(["Step 2", "Step 3", "Step 4"]));
    const listReads = () => calls.filter((c) => c.method === "GET" && c.path.includes("parentId=1")).length;
    const readsBefore = listReads();

    act(() => within(rows).getByRole("checkbox", { name: "Mark #2 done" }).focus());
    fireEvent.keyDown(window, { key: "j", altKey: true });

    // Before the server answered.
    expect(titles()).toEqual(["Step 3", "Step 2", "Step 4"]);
    gate.open();
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(2));
    await waitFor(() => expect(listReads()).toBe(readsBefore + 1));
    expect(titles()).toEqual(["Step 3", "Step 2", "Step 4"]);
  });

  it("asks before done when subtasks are open and closes them together on Yes", async () => {
    const user = userEvent.setup();
    const calls = renderParent();
    await screen.findByRole("list", { name: "Subtasks in order" }, LAZY_PAGE);
    fireEvent.keyDown(window, { key: "x" });
    const dialog = await screen.findByRole("dialog", {
      name: "2 subtasks are still open. Mark them done too?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Yes, mark them done" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/todos/bulk")).toBe(true));
    expect(calls.find((c) => c.path === "/api/v1/todos/bulk")?.body).toEqual({
      ids: [1, 2, 3],
      patch: { status: "done" },
    });
    expect(calls.some((c) => c.method === "PATCH" && c.path === "/api/v1/todos/1")).toBe(false);
  });

  it("marks only the parent on No", async () => {
    const user = userEvent.setup();
    const calls = renderParent();
    await screen.findByRole("list", { name: "Subtasks in order" }, LAZY_PAGE);
    fireEvent.keyDown(window, { key: "x" });
    const dialog = await screen.findByRole("dialog", { name: /still open/ });
    await user.click(within(dialog).getByRole("button", { name: "No, only #1" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "PATCH" && c.path === "/api/v1/todos/1")).toBe(true),
    );
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ status: "done" });
    expect(calls.some((c) => c.path === "/api/v1/todos/bulk")).toBe(false);
  });

  it("links another todo by #id with the chosen kind from b", async () => {
    const user = userEvent.setup();
    const calls = renderParent();
    await screen.findByRole("list", { name: "Subtasks in order" }, LAZY_PAGE);
    fireEvent.keyDown(window, { key: "b" });
    const dialog = await screen.findByRole("dialog", { name: "Link #1 to another todo" });
    await user.click(within(dialog).getByLabelText(/^Blocks/));
    await user.type(within(dialog).getByPlaceholderText("#id or words from the title"), "#5");
    await user.click(await within(dialog).findByText("Label the cables"));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/todos/1/links")).toBe(true));
    expect(calls.find((c) => c.path === "/api/v1/todos/1/links")?.body).toEqual({
      links: [{ kind: "blocks", todoId: 5 }],
    });
  });
});

describe("repeat on the todo page", () => {
  it("opens with shift+r and saves a preset", async () => {
    const user = userEvent.setup();
    const calls = renderParent({ dueOn: "2026-11-12" });
    await screen.findByRole("list", { name: "Subtasks in order" }, LAZY_PAGE);
    fireEvent.keyDown(window, { key: "R", shiftKey: true });
    const panel = await screen.findByRole("group", { name: "Repeat" });
    await user.click(within(panel).getByRole("button", { name: /Every week on Thu/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
      recurrence: { every: "week", interval: 1, basis: "schedule", weekdays: ["thu"] },
    });
  });

  it("stays closed without a date and says why", async () => {
    renderParent();
    await screen.findByRole("list", { name: "Subtasks in order" }, LAZY_PAGE);
    fireEvent.keyDown(window, { key: "R", shiftKey: true });
    expect(screen.queryByRole("group", { name: "Repeat" })).toBeNull();
    expect(screen.getByText("Set a due date or planned day first.")).toBeTruthy();
  });
});

describe("subtask helpers", () => {
  it("turns pasted lines into titles without list markers", () => {
    expect(pastedTitles("- [x] One\r\n* Two\n\n  1) Three  \n")).toEqual(["One", "Two", "Three"]);
    expect(pastedTitles("x".repeat(400))[0]).toHaveLength(300);
  });

  it("finds the index one step away and stops at the ends", () => {
    expect(stepTarget([4, 5, 6], 4, 1)).toBe(1);
    expect(stepTarget([4, 5, 6], 4, -1)).toBeNull();
    expect(stepTarget([4, 5, 6], 6, 1)).toBeNull();
    expect(stepTarget([4, 5, 6], 7, 1)).toBeNull();
  });
});
