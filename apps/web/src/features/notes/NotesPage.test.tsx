import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandsProvider } from "../../app/commands.tsx";
import { routeTree } from "../../app/router.tsx";
import { ToastProvider } from "../../components/toast/ToastProvider.tsx";
import { KeyboardProvider } from "../../keyboard/KeyboardProvider.tsx";
import { mockApi, typeOnFakeClock } from "../../test/render.tsx";

// The route loads this page lazily. Loading it here, with the test file, keeps the import (and the
// editor) out of the first test's time limit.
await import("./NotesPage.tsx");

const T = "2026-11-01T09:00:00.000Z";
const homeLab = {
  id: 3,
  slug: "home-lab",
  name: "Home lab",
  description: "",
  color: "#4C9AFF",
  archivedAt: null,
  createdAt: T,
  updatedAt: T,
  openCount: 0,
};

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

// Rendering waits for the lazy route to resolve and the first queries to answer.
const LAZY_PAGE = { timeout: 5000 };

function renderAt(path: string) {
  const calls = mockApi(({ path: url }) => {
    if (url === "/api/v1/projects") return { body: [homeLab] };
    if (url.startsWith("/api/v1/notes")) return { body: { items: [], total: 0, limit: 500, offset: 0 } };
    return { status: 404, body: { error: { code: "not_found", message: "Not here." } } };
  });
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
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

describe("new note from the notes list", () => {
  it("starts in the project the list is filtered to when n is pressed", async () => {
    renderAt("/notes?project=home-lab");
    await screen.findByText("No note matches. Clear the filter or pick another project.", {}, LAZY_PAGE);
    fireEvent.keyDown(window, { key: "n" });
    const dialog = await screen.findByRole("dialog", { name: "New note" });
    expect(within(dialog).getByRole("button", { name: "Project Home lab" })).toBeTruthy();
  });

  it("starts without a project on the unfiltered list", async () => {
    renderAt("/notes");
    await screen.findByText("No notes yet. Press n to write one.", {}, LAZY_PAGE);
    fireEvent.keyDown(window, { key: "n" });
    const dialog = await screen.findByRole("dialog", { name: "New note" });
    expect(within(dialog).getByRole("button", { name: "Project No project" })).toBeTruthy();
  });
});

describe("notes filter", () => {
  it("asks the server once typing pauses, not for every letter", async () => {
    const calls = renderAt("/notes");
    await screen.findByText("No notes yet. Press n to write one.", {}, LAZY_PAGE);
    const filter = screen.getByRole("textbox", { name: "Filter notes by title" });
    // 60 ms per key: faster than the 150 ms typing pause, slow enough for each render to land.
    await typeOnFakeClock(filter, ["p", "pl", "pla", "plan"], 60, 150);
    await waitFor(() => expect(calls.some((c) => c.path.includes("q=plan"))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      calls.filter((c) => c.path.startsWith("/api/v1/notes") && c.path.includes("q=")).map((c) => c.path),
    ).toEqual([expect.stringContaining("q=plan")]);
  });
});
