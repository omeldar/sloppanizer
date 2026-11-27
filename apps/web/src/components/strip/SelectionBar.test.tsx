import { PROJECT_COLORS, type Space, type Todo } from "@organizer/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSpace } from "../../lib/api.ts";
import { makeBrief, makeLabel, makePerson, makeTodo, mockApi, renderWithApp } from "../../test/render.tsx";
import { StripList } from "./StripList.tsx";

// S5#14: the checkbox selects, and the bar over the list changes all selected todos at once.

const T = "2026-11-01T09:00:00.000Z";

// cmdk (the pickers) measures its list and scrolls the selected item into view; jsdom has neither.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView ??= () => {};
});

afterEach(() => {
  vi.unstubAllGlobals();
  setSpace(null);
});

const todos: Todo[] = [
  makeTodo({
    id: 1,
    title: "First",
    status: "in_progress",
    labels: [makeLabel("homelab")],
    requestedBy: [makeBrief("Anna", "Meier", 3)],
  }),
  makeTodo({ id: 2, title: "Second" }),
  makeTodo({ id: 3, title: "Third", projectId: 4 }),
];

const work = {
  id: 4,
  slug: "work",
  name: "Work",
  description: "",
  color: PROJECT_COLORS[1],
  archivedAt: null,
  createdAt: T,
  updatedAt: T,
  openCount: 1,
};

const space: Space = {
  id: 7,
  name: "Home move",
  color: PROJECT_COLORS[0],
  system: null,
  projectSlug: "home-move",
  openCount: 3,
  role: "owner",
  members: [
    { accountId: 1, username: "anna", name: "Anna Berg", role: "owner", addedAt: T },
    { accountId: 2, username: "bobo", name: "Bo Lind", role: "member", addedAt: T },
  ],
  createdAt: T,
};

/** Answers the lookups the pickers make and every bulk call; fail makes the bulk calls fail. */
function server(fail = false) {
  return mockApi(({ method, path, body }) => {
    if (path === "/api/v1/todos/bulk" && method === "POST") {
      if (fail) return { status: 422, body: { error: { code: "validation_failed", message: "No." } } };
      const { ids } = body as { ids: number[] };
      return { body: { updated: ids.map((id) => todos.find((t) => t.id === id) ?? makeTodo({ id })) } };
    }
    if (path === "/api/v1/projects") return { body: [work] };
    if (path === "/api/v1/labels") return { body: [makeLabel("homelab"), makeLabel("work")] };
    if (path.startsWith("/api/v1/people")) return { body: [makePerson("Bo", "Berg", 5)] };
    if (path.startsWith("/api/v1/users")) return { body: [] };
    if (path === "/api/v1/spaces/7") return { body: space };
    return { status: 404, body: { error: { code: "not_found", message: "Not here." } } };
  });
}

const bulkCalls = (calls: ReturnType<typeof server>) =>
  calls.filter((c) => c.method === "POST" && c.path === "/api/v1/todos/bulk").map((c) => c.body);

function renderList(items: Todo[] = todos) {
  return renderWithApp(
    <StripList items={items.map((todo) => ({ todo }))} label="Inbox" collapseOnDone={false} />,
  );
}

const toolbar = () => screen.getByRole("toolbar", { name: "Selected todos" });

async function select(...ids: number[]) {
  for (const id of ids) {
    // oxlint-disable-next-line no-await-in-loop -- clicks, one after the other
    await userEvent.click(await screen.findByRole("checkbox", { name: `Select #${id}` }));
  }
}

describe("selecting todos in a list (S5#14)", () => {
  it("selects with the checkbox without marking anything done, then selects all and clears", async () => {
    const calls = server();
    renderList();
    await select(2);
    expect(within(toolbar()).getByText("1 selected")).toBeTruthy();
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);

    await userEvent.click(within(toolbar()).getByRole("button", { name: "Select all 3" }));
    expect(within(toolbar()).getByText("3 selected")).toBeTruthy();
    expect(within(toolbar()).queryByRole("button", { name: /Select all/ })).toBeNull();

    await userEvent.click(within(toolbar()).getByRole("button", { name: /Clear/ }));
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(screen.getAllByRole("checkbox").every((box) => !(box as HTMLInputElement).checked)).toBe(true);
  });

  it("clears the selection with Esc and toggles the cursor row with v", async () => {
    server();
    renderList();
    await screen.findByText("First");
    await userEvent.keyboard("jv");
    expect(within(toolbar()).getByText("1 selected")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Select #1" })).toHaveProperty("checked", true);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("selects a range with shift-click", async () => {
    server();
    renderList();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "Select #1" }));
    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("checkbox", { name: "Select #3" }));
    await user.keyboard("{/Shift}");
    expect(within(toolbar()).getByText("3 selected")).toBeTruthy();
  });

  it("marks the selection done in one call, says so, and undo puts each status back", async () => {
    const calls = server();
    renderList();
    await select(1, 2);
    await userEvent.click(within(toolbar()).getByRole("button", { name: "Done" }));
    expect(await screen.findByText("Marked 2 todos done")).toBeTruthy();
    expect(bulkCalls(calls)).toEqual([{ ids: [1, 2], patch: { status: "done" } }]);

    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(bulkCalls(calls)).toHaveLength(3));
    expect(bulkCalls(calls).slice(1)).toEqual([
      { ids: [1], patch: { status: "in_progress" } },
      { ids: [2], patch: { status: "open" } },
    ]);
  });

  it("keeps marking a single todo done one click away, with the done button", async () => {
    const calls = mockApi(({ method }) => ({
      body: method === "PATCH" ? { ...todos[1], status: "done" } : todos[1],
    }));
    renderList();
    await userEvent.click(await screen.findByRole("button", { name: "Mark #2 done" }));
    expect(await screen.findByText("Marked #2 done")).toBeTruthy();
    expect(calls.find((c) => c.method === "PATCH")).toEqual({
      method: "PATCH",
      path: "/api/v1/todos/2",
      body: { status: "done" },
    });
  });

  it("sets the status and the priority from their menus", async () => {
    const calls = server();
    renderList();
    await select(2, 3);
    fireEvent.keyDown(within(toolbar()).getByRole("button", { name: "Status" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Blocked" }));
    expect(await screen.findByText("Set 2 todos to blocked")).toBeTruthy();
    fireEvent.keyDown(within(toolbar()).getByRole("button", { name: "Priority" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "High" }));
    expect(await screen.findByText("Set priority high on 2 todos")).toBeTruthy();
    expect(bulkCalls(calls)).toEqual([
      { ids: [2, 3], patch: { status: "blocked" } },
      { ids: [2, 3], patch: { addLabels: ["priority::high"] } },
    ]);
  });

  it("moves the selection to a project or the Inbox", async () => {
    const calls = server();
    renderList();
    await select(1, 2);
    await userEvent.click(within(toolbar()).getByRole("button", { name: "Move" }));
    await userEvent.click(await screen.findByRole("option", { name: /Work/ }));
    expect(await screen.findByText("Moved 2 todos to Work")).toBeTruthy();
    await userEvent.click(within(toolbar()).getByRole("button", { name: "Move" }));
    await userEvent.click(await screen.findByRole("option", { name: /Inbox/ }));
    expect(await screen.findByText("Moved 2 todos to the Inbox")).toBeTruthy();
    expect(bulkCalls(calls)).toEqual([
      { ids: [1, 2], patch: { projectId: 4 } },
      { ids: [1, 2], patch: { projectId: null } },
    ]);
  });

  it("adds and removes labels, and undo restores each todo's own labels", async () => {
    const calls = server();
    renderList();
    await select(1, 2);
    await userEvent.click(within(toolbar()).getByRole("button", { name: "Add labels" }));
    await userEvent.click(await screen.findByRole("option", { name: "work" }));
    await userEvent.click(screen.getByRole("button", { name: "Add to 2 todos" }));
    expect(await screen.findByText("Added work to 2 todos")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(bulkCalls(calls)).toHaveLength(3));

    await userEvent.click(within(toolbar()).getByRole("button", { name: "Remove labels" }));
    await userEvent.click(await screen.findByRole("option", { name: "homelab" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove from 2 todos" }));
    expect(await screen.findByText("Removed homelab from 2 todos")).toBeTruthy();
    expect(bulkCalls(calls)).toEqual([
      { ids: [1, 2], patch: { addLabels: ["work"] } },
      { ids: [1], patch: { labels: ["homelab"] } },
      { ids: [2], patch: { labels: [] } },
      { ids: [1, 2], patch: { removeLabels: ["homelab"] } },
    ]);
  });

  it("asks before requested by overwrites someone, naming the todos and who they have now", async () => {
    const calls = server();
    renderList();
    await select(1, 2);
    await userEvent.click(within(toolbar()).getByRole("button", { name: "Requested by" }));
    await userEvent.click(await screen.findByRole("option", { name: /Bo Berg/ }));
    await userEvent.click(screen.getByRole("button", { name: "Replace on 2 todos" }));

    const dialog = await screen.findByRole("dialog", { name: "Replace requested by on 2 todos?" });
    expect(dialog.textContent).toContain("This overwrites requested by on 1 of them:");
    expect(within(dialog).getByRole("listitem").textContent).toBe("#1 First: Anna Meier");
    expect(dialog.textContent).toContain("Afterwards every todo has only Bo Berg as requested by.");
    expect(bulkCalls(calls)).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole("button", { name: "Replace on 2 todos" }));
    expect(await screen.findByText("Set requested by to Bo Berg on 2 todos")).toBeTruthy();
    expect(bulkCalls(calls)).toEqual([{ ids: [1, 2], patch: { requestedBy: [{ personId: 5 }] } }]);

    // Undo gives #1 Anna back and #2 nobody.
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(bulkCalls(calls)).toHaveLength(3));
    expect(bulkCalls(calls).slice(1)).toEqual([
      { ids: [1], patch: { requestedBy: [{ personId: 3 }] } },
      { ids: [2], patch: { requestedBy: [] } },
    ]);
  });

  it("does nothing when the requested by warning is cancelled", async () => {
    const calls = server();
    renderList();
    await select(1);
    await userEvent.click(within(toolbar()).getByRole("button", { name: "Requested by" }));
    await userEvent.click(await screen.findByRole("option", { name: /Bo Berg/ }));
    await userEvent.click(screen.getByRole("button", { name: "Replace on 1 todo" }));
    const dialog = await screen.findByRole("dialog", { name: "Replace requested by on 1 todo?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(bulkCalls(calls)).toHaveLength(0);
  });

  it("sets requested by without asking when nobody would be overwritten, and adds contacts", async () => {
    const calls = server();
    renderList();
    await select(2, 3);
    await userEvent.click(within(toolbar()).getByRole("button", { name: "Requested by" }));
    await userEvent.click(await screen.findByRole("option", { name: /Bo Berg/ }));
    await userEvent.click(screen.getByRole("button", { name: "Replace on 2 todos" }));
    expect(await screen.findByText("Set requested by to Bo Berg on 2 todos")).toBeTruthy();

    await userEvent.click(within(toolbar()).getByRole("button", { name: "Add contacts" }));
    await userEvent.click(await screen.findByRole("option", { name: /Bo Berg/ }));
    await userEvent.click(screen.getByRole("button", { name: "Add to 2 todos" }));
    expect(await screen.findByText("Added Bo Berg as contact to 2 todos")).toBeTruthy();
    expect(bulkCalls(calls)).toEqual([
      { ids: [2, 3], patch: { requestedBy: [{ personId: 5 }] } },
      { ids: [2, 3], patch: { addContacts: [{ personId: 5 }] } },
    ]);
  });

  it("plans and clears the due date of the selection", async () => {
    const calls = server();
    renderList();
    await select(1, 2);
    await userEvent.click(within(toolbar()).getByRole("button", { name: "Planned" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Planned for" }), {
      target: { value: "03.12.2026" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Set" }));
    expect(await screen.findByText(/^Planned 2 todos for /)).toBeTruthy();
    await userEvent.click(within(toolbar()).getByRole("button", { name: "Due" }));
    await userEvent.click(await screen.findByRole("button", { name: "Clear due dates" }));
    expect(await screen.findByText("Cleared the due date of 2 todos")).toBeTruthy();
    expect(bulkCalls(calls)).toEqual([
      { ids: [1, 2], patch: { plannedOn: "2026-12-03" } },
      { ids: [1, 2], patch: { dueOn: null } },
    ]);
  });

  it("says what went wrong and keeps the selection when the change fails", async () => {
    server(true);
    renderList();
    await select(1, 2);
    await userEvent.click(within(toolbar()).getByRole("button", { name: "Done" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not change the todos. No.");
    expect(within(toolbar()).getByText("2 selected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("offers no assignee outside shared projects", async () => {
    server();
    renderList();
    await select(1);
    expect(within(toolbar()).queryByRole("button", { name: "Assign" })).toBeNull();
  });

  it("assigns the selection to a member in a shared project's tab", async () => {
    setSpace(7);
    const calls = server();
    renderList();
    await select(1, 2);
    const assign = within(toolbar()).getByRole("button", { name: "Assign" });
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/spaces/7")).toBe(true));
    fireEvent.keyDown(assign, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Bo Lind (bobo)" }));
    expect(await screen.findByText("Assigned 2 todos to bobo")).toBeTruthy();
    expect(bulkCalls(calls)).toEqual([{ ids: [1, 2], patch: { assignee: "bobo" } }]);
  });
});
