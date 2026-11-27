import type { Space } from "@organizer/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { headersOf, makeTodo, type RecordedCall } from "../../test/render.tsx";
import { renderAppAt } from "../../test/renderApp.tsx";

// The week board in your own tab shows the todos assigned to you in shared projects (S5#13).

afterEach(() => vi.unstubAllGlobals());

const T = "2026-11-01T09:00:00.000Z";
const H = "x-sloppanizer-space";
const space: Space = {
  id: 7,
  name: "Home move",
  color: "#4C9AFF",
  system: null,
  projectSlug: "home-move",
  openCount: 1,
  role: "member",
  members: [],
  createdAt: T,
};
const anna = { accountId: 1, username: "anna", name: "Anna" };
// Number 3 in the shared project, and an own todo with the same number.
const shared = makeTodo({ id: 3, title: "Return keys", plannedOn: "2026-11-18", assignee: anna });
const own = makeTodo({ id: 3, title: "Renew passport", plannedOn: "2026-11-17" });

function renderWeek() {
  return renderAppAt("/week?start=2026-11-16", (call: RecordedCall) => {
    const path = call.path.split("?")[0];
    const inSpace = headersOf(call)[H] === "7";
    if (path === "/api/v1/spaces") return { body: [space] };
    if (path === "/api/v1/todos/3" && call.method === "PATCH")
      return { body: inSpace ? { ...shared, plannedOn: "2026-11-19" } : own };
    if (path === "/api/v1/todos") {
      const planned = call.path.includes("plannedFrom");
      const items = planned ? [inSpace ? shared : own] : [];
      return { body: { items, total: items.length, limit: 200, offset: 0 } };
    }
    if (path === "/api/v1/projects" || path === "/api/v1/labels") return { body: [] };
    return { status: 404, body: { error: { code: "not_found", message: "Not here." } } };
  });
}

describe("shared projects on the week board", () => {
  it("shows them on their day next to your own todo of the same number, and plans them there", async () => {
    const { calls } = renderWeek();
    const wednesday = await screen.findByRole("region", { name: /^Wed 18\.11\.2026/ }, { timeout: 5000 });
    const card = await within(wednesday).findByText("Return keys");
    expect(within(wednesday).getByText("Home move")).toBeTruthy();
    expect(card.closest("a")?.getAttribute("href")).toBeNull();
    const tuesday = screen.getByRole("region", { name: /^Tue 17\.11\.2026/ });
    expect(within(tuesday).getByText("Renew passport")).toBeTruthy();
    // The shared project is asked for the todos assigned to you only.
    const asked = calls.filter((c) => c.path.startsWith("/api/v1/todos?") && headersOf(c)[H] === "7");
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((c) => c.path.includes("assignee=me"))).toBe(true);

    fireEvent.mouseDown(card);
    fireEvent.keyDown(window, { key: "L", shiftKey: true });
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch).toEqual({ method: "PATCH", path: "/api/v1/todos/3", body: { plannedOn: "2026-11-19" } });
    expect(patch && headersOf(patch)[H]).toBe("7");
    expect(await screen.findByText(/^Planned "Return keys" for Thu 19\.11\.2026/)).toBeTruthy();
  });
});
