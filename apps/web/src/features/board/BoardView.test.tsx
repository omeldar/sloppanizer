import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTodo, mockApi, renderWithApp } from "../../test/render.tsx";
import { boardColumns, BoardView } from "./BoardView.tsx";

afterEach(() => vi.unstubAllGlobals());

describe("boardColumns", () => {
  it("groups by status, orders by position then id, and lists a todo once", () => {
    const todos = [
      makeTodo({ id: 3, status: "open", position: 5 }),
      makeTodo({ id: 1, status: "open", position: 5 }),
      makeTodo({ id: 2, status: "open", position: -1 }),
      makeTodo({ id: 4, status: "blocked" }),
      makeTodo({ id: 2, status: "open", position: -1 }),
    ];
    const columns = boardColumns(todos);
    expect(columns.open.map((t) => t.id)).toEqual([2, 1, 3]);
    expect(columns.blocked.map((t) => t.id)).toEqual([4]);
    expect(columns.in_progress).toEqual([]);
  });

  it("shows an unsaved move to Done at the top of Done", () => {
    const columns = boardColumns(
      [makeTodo({ id: 1, status: "open" }), makeTodo({ id: 9, status: "done" })],
      new Map([[1, { status: "done", position: 0 }]]),
    );
    expect(columns.done.map((t) => t.id)).toEqual([1, 9]);
    expect(columns.open).toEqual([]);
  });
});

function page(items: ReturnType<typeof makeTodo>[]) {
  return { items, total: items.length, limit: 500, offset: 0 };
}

describe("board keys", () => {
  it("moves the selected todo one column right with shift+l and undoes it", async () => {
    let todo = makeTodo({ id: 7, title: "Patch the firewall", status: "open" });
    const calls = mockApi(({ method, path, body }) => {
      if (method === "PATCH") {
        todo = { ...todo, ...(body as object) };
        return { body: todo };
      }
      if (path.startsWith("/api/v1/todos?")) {
        const done = path.includes("status=done");
        return { body: page((todo.status === "done") === done ? [todo] : []) };
      }
      return { status: 404, body: { error: { code: "not_found", message: "no" } } };
    });
    renderWithApp(<BoardView filters={{}} />);
    const open = await screen.findByRole("region", { name: "Open" });
    await within(open).findByText("Patch the firewall");

    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "L" });

    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")).toMatchObject({
        path: "/api/v1/todos/7",
        body: { status: "in_progress" },
      }),
    );
    const progress = screen.getByRole("region", { name: "In progress" });
    await within(progress).findByText("Patch the firewall");

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(calls.findLast((c) => c.method === "PATCH")?.body).toEqual({ status: "open", position: 0 }),
    );
  });

  it("asks for the last 14 days of done todos", async () => {
    const calls = mockApi(() => ({ body: page([]) }));
    renderWithApp(<BoardView filters={{ projectId: "inbox" }} />);
    await screen.findByRole("region", { name: "Done" });
    const done = calls.find((c) => c.path.includes("status=done"));
    expect(done?.path).toMatch(/doneAfter=\d{4}-\d{2}-\d{2}/);
    expect(done?.path).toContain("projectId=inbox");
  });
});
