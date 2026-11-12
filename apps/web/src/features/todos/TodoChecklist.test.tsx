import type { Todo } from "@organizer/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandsProvider } from "../../app/commands.tsx";
import { routeTree } from "../../app/router.tsx";
import { ToastProvider } from "../../components/toast/ToastProvider.tsx";
import { KeyboardProvider } from "../../keyboard/KeyboardProvider.tsx";
import { makeTodo, mockApi } from "../../test/render.tsx";

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

const LAZY_PAGE = { timeout: 5000 };

function renderTodo(onToggle: (body: unknown) => { status?: number; body?: unknown }) {
  let todo: Todo = makeTodo({ id: 1, descriptionMd: "- [ ] Order cables\n- [x] Mount the rack" });
  const calls = mockApi(({ method, path, body }) => {
    if (method === "POST" && path === "/api/v1/todos/1/checklist") {
      const answer = onToggle(body);
      if (answer.status === undefined && answer.body) todo = answer.body as Todo;
      return answer;
    }
    if (path === "/api/v1/todos/1") return { body: todo };
    if (path === "/api/v1/todos/1/activity") return { body: { todoId: 1, items: [] } };
    if (path === "/api/v1/me") return { body: { actor: "you", via: "session", scope: "write" } };
    if (path === "/api/v1/projects" || path === "/api/v1/labels") return { body: [] };
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

describe("checklist on the todo page", () => {
  it("ticks an item through the checklist endpoint and shows the new count", async () => {
    const calls = renderTodo(() => ({
      body: makeTodo({ id: 1, descriptionMd: "- [x] Order cables\n- [x] Mount the rack" }),
    }));
    expect(await screen.findByText("Checklist 1 of 2", {}, LAZY_PAGE)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Order cables" }));
    await screen.findByText("Checklist 2 of 2", {}, LAZY_PAGE);
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ index: 0, checked: true, text: "Order cables" });
    expect((screen.getByRole("checkbox", { name: "Order cables" }) as HTMLInputElement).checked).toBe(true);
    // The description is not saved as a whole: only the one click went out.
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("reloads the todo and says so when the checklist changed meanwhile", async () => {
    const calls = renderTodo(() => ({
      status: 409,
      body: {
        error: {
          code: "conflict",
          message: "The checklist changed. Reload and try again.",
          details: { items: [] },
        },
      },
    }));
    await screen.findByText("Checklist 1 of 2", {}, LAZY_PAGE);
    const loads = () => calls.filter((c) => c.method === "GET" && c.path === "/api/v1/todos/1").length;
    const before = loads();
    fireEvent.click(screen.getByRole("checkbox", { name: "Order cables" }));
    await screen.findByText("The checklist changed. Try again.", {}, LAZY_PAGE);
    await waitFor(() => expect(loads()).toBeGreaterThan(before));
  });
});
