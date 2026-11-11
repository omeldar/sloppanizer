import type { Todo } from "@organizer/shared";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeLabel, makeTodo, mockApi, renderWithApp } from "../../test/render.tsx";
import { StripList } from "./StripList.tsx";

afterEach(() => vi.unstubAllGlobals());

/** A tiny fake server for PATCH /todos/:id that keeps the todo state. */
function fakeServer(todos: Todo[], fail = false) {
  const state = new Map(todos.map((t) => [t.id, t]));
  return mockApi(({ method, path, body }) => {
    const id = Number(/\/todos\/(\d+)/.exec(path)?.[1]);
    if (method === "PATCH") {
      if (fail)
        return {
          status: 422,
          body: { error: { code: "validation_failed", message: "Status is not allowed." } },
        };
      const patch = body as Partial<Todo> & { addLabels?: string[] };
      const current = state.get(id) as Todo;
      const next = {
        ...current,
        ...(patch.status && {
          status: patch.status,
          doneAt: patch.status === "done" ? "2026-11-11T10:00:00.000Z" : null,
        }),
        ...(patch.addLabels && { labels: patch.addLabels.map((name) => makeLabel(name)) }),
      };
      state.set(id, next);
      return { body: next };
    }
    return { body: state.get(id) };
  });
}

const todos = [
  makeTodo({ id: 1, title: "First" }),
  makeTodo({ id: 2, title: "Second" }),
  makeTodo({ id: 3, title: "Third" }),
];

describe("StripList", () => {
  it("marks a todo done from the checkbox and undoes it from the toast", async () => {
    const calls = fakeServer(todos);
    renderWithApp(<StripList items={todos.map((todo) => ({ todo }))} label="Inbox" collapseOnDone={false} />);
    await userEvent.click(await screen.findByRole("checkbox", { name: "Mark #2 done" }));

    expect(await screen.findByText("Marked #2 done")).toBeTruthy();
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches).toEqual([{ method: "PATCH", path: "/api/v1/todos/2", body: { status: "done" } }]);

    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(calls.findLast((c) => c.method === "PATCH")).toEqual({
        method: "PATCH",
        path: "/api/v1/todos/2",
        body: { status: "open" },
      }),
    );
    expect(screen.queryByText("Marked #2 done")).toBeNull();
  });

  it("undo puts an in progress todo back to in progress, not to open", async () => {
    const started = [makeTodo({ id: 7, status: "in_progress" })];
    const calls = fakeServer(started);
    renderWithApp(
      <StripList items={started.map((todo) => ({ todo }))} label="List" collapseOnDone={false} />,
    );
    await userEvent.click(await screen.findByRole("checkbox", { name: "Mark #7 done" }));
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(calls.at(-1)?.body).toEqual({ status: "in_progress" }));
  });

  it("moves with j and k and marks the selected todo done with x", async () => {
    const calls = fakeServer(todos);
    renderWithApp(<StripList items={todos.map((todo) => ({ todo }))} label="Inbox" collapseOnDone={false} />);
    await screen.findByText("First");
    await userEvent.keyboard("jjjk");
    const selected = document.querySelector("[aria-current='true']");
    expect(selected?.textContent).toContain("Second");
    await userEvent.keyboard("x");
    expect(await screen.findByText("Marked #2 done")).toBeTruthy();
    expect(calls.find((c) => c.method === "PATCH")?.path).toBe("/api/v1/todos/2");
  });

  it("sets the priority with 1 to 4 on the selected todo", async () => {
    const calls = fakeServer(todos);
    renderWithApp(<StripList items={todos.map((todo) => ({ todo }))} label="Inbox" />);
    await screen.findByText("First");
    await userEvent.keyboard("j2");
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ addLabels: ["priority::high"] }),
    );
  });

  it("opens the selected todo with Enter", async () => {
    fakeServer(todos);
    const { router } = renderWithApp(<StripList items={todos.map((todo) => ({ todo }))} label="Inbox" />);
    await screen.findByText("First");
    await userEvent.keyboard("j{Enter}");
    await waitFor(() => expect(router.state.location.pathname).toBe("/todos/1"));
  });

  it("shows what went wrong when marking done fails, and offers no undo", async () => {
    fakeServer(todos, true);
    renderWithApp(<StripList items={todos.map((todo) => ({ todo }))} label="Inbox" collapseOnDone={false} />);
    await userEvent.click(await screen.findByRole("checkbox", { name: "Mark #1 done" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not mark #1 done. Status is not allowed.");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("does nothing on x when no row is selected", async () => {
    const calls = fakeServer(todos);
    renderWithApp(<StripList items={todos.map((todo) => ({ todo }))} label="Inbox" />);
    await screen.findByText("First");
    await userEvent.keyboard("x");
    expect(calls).toHaveLength(0);
  });
});
