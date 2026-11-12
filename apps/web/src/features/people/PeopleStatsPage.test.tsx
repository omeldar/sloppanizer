import type { PeopleStats, PersonStat } from "@organizer/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandsProvider } from "../../app/commands.tsx";
import { routeTree } from "../../app/router.tsx";
import { ToastProvider } from "../../components/toast/ToastProvider.tsx";
import { KeyboardProvider } from "../../keyboard/KeyboardProvider.tsx";
import { makeBrief, mockApi } from "../../test/render.tsx";

const HOUR = 3_600_000;

function stat(
  id: number,
  first: string,
  last: string,
  team: string,
  numbers: Partial<PersonStat["requested"]>,
): PersonStat {
  return {
    person: makeBrief(first, last, id, { team }),
    requested: {
      total: 0,
      open: 0,
      done: 0,
      medianDoneMs: null,
      p90DoneMs: null,
      oldestOpenDays: null,
      lastAt: null,
      ...numbers,
    },
    contact: { total: 2, open: 1, done: 1 },
  };
}

const anna = stat(1, "Anna", "Meier", "Platform", {
  total: 14,
  open: 3,
  done: 11,
  medianDoneMs: 52 * HOUR,
  p90DoneMs: 200 * HOUR,
  oldestOpenDays: 9,
});
const luca = stat(2, "Luca", "Brunner", "", { total: 4, open: 4, done: 0, oldestOpenDays: 30 });

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

function renderAt(path: string, items: PersonStat[] = [anna, luca]) {
  const calls = mockApi(({ path: url }) => {
    if (url.startsWith("/api/v1/stats/people")) {
      const body: PeopleStats = {
        from: null,
        to: null,
        role: url.includes("role=contact") ? "contact" : "requester",
        totals: { todos: 18, open: 7, done: 11, medianDoneMs: 52 * HOUR },
        items,
      };
      return { body };
    }
    if (url === "/api/v1/projects") return { body: [] };
    if (url === "/api/v1/labels") return { body: [] };
    if (
      url.startsWith("/api/v1/teams") ||
      url.startsWith("/api/v1/person-tags") ||
      url.startsWith("/api/v1/topics")
    )
      return { body: [] };
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
  const statsCalls = () =>
    calls
      .filter((c) => c.path.startsWith("/api/v1/stats/people"))
      .map((c) => new URL(c.path, "http://x").searchParams);
  return { router, statsCalls };
}

describe("people statistics", () => {
  it("shows the summary and one row per person with the requester numbers", async () => {
    renderAt("/people/stats?period=all");
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    const first = within(rows[1] as HTMLElement)
      .getAllByRole("cell")
      .map((c) => c.textContent);
    expect(first).toEqual(["1", "Anna MeierPlatform", "14", "3", "11", "2d 4h", "8d 8h", "9d", "2", "-", ""]);
    const summary = screen.getByRole("list", { name: "Summary" });
    expect(summary.textContent).toContain("18 todos");
    expect(summary.textContent).toContain("2d 4h median took");
  });

  it("sends the URL filters and changes the sort from a header click", async () => {
    const { router, statsCalls } = renderAt(
      "/people/stats?period=all&topic=dns,backup&tag=fast&team=Platform",
    );
    await screen.findByRole("table");
    const sent = statsCalls().at(-1);
    expect(sent?.get("topic")).toBe("dns,backup");
    expect(sent?.get("tag")).toBe("fast");
    expect(sent?.get("team")).toBe("Platform");
    expect(sent?.get("sort")).toBe("total");
    expect(sent?.has("from")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Median took" }));
    await waitFor(() => expect(statsCalls().at(-1)?.get("sort")).toBe("speed"));
    expect(router.state.location.search).toMatchObject({ sort: "speed", topic: "dns,backup" });
    expect(screen.getByRole("columnheader", { name: "Median took" }).getAttribute("aria-sort")).toBe(
      "ascending",
    );
  });

  it("asks for a period ending today by default and switches to contacts", async () => {
    const { statsCalls } = renderAt("/people/stats");
    await screen.findByRole("table");
    expect(statsCalls().at(-1)?.get("to")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(statsCalls().at(-1)?.get("role")).toBe("requester");
    fireEvent.click(screen.getByRole("button", { name: "Contacts" }));
    await waitFor(() => expect(statsCalls().at(-1)?.get("role")).toBe("contact"));
    expect(await screen.findByRole("columnheader", { name: "Contact for" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Median took" })).toBeNull();
  });

  it("moves with j and k and opens the person with Enter", async () => {
    const { router } = renderAt("/people/stats?period=all");
    await screen.findByRole("table");
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/people/2"));
  });

  it("says how to widen the filters when nobody matches", async () => {
    renderAt("/people/stats?period=30d&topic=dns", []);
    expect(await screen.findByText(/Pick a longer period or All time/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "clear every filter" })).toBeTruthy();
  });
});
