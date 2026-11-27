import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTodo, type RecordedCall } from "../../test/render.tsx";
import { renderAppAt } from "../../test/renderApp.tsx";

await import("./InboxPage.tsx");

afterEach(() => vi.unstubAllGlobals());

const marked = makeTodo({
  id: 2,
  title: "Sign the form",
  actionNeeded: { reason: "Sign it", by: "assistant", at: "2026-11-11T09:00:00.000Z" },
});
const plain = makeTodo({ id: 3, title: "Water plants" });

describe("action needed filter in a list (S5#6)", () => {
  it("offers the filter while something is marked and lists only those with it", async () => {
    const { calls } = renderAppAt("/inbox", (call: RecordedCall) => {
      const [path, query = ""] = call.path.split("?");
      if (path === "/api/v1/todos") {
        const items = query.includes("actionNeeded=true") ? [marked] : [marked, plain];
        return { body: { items, total: items.length, limit: 500, offset: 0 } };
      }
      if (path === "/api/v1/projects" || path === "/api/v1/labels") return { body: [] };
      return { status: 404, body: { error: { code: "not_found", message: "no" } } };
    });
    const filter = await screen.findByRole("button", { name: "Action needed 1" }, { timeout: 5000 });
    expect(await screen.findByRole("link", { name: "Water plants" })).toBeTruthy();
    fireEvent.click(filter);
    await waitFor(() => expect(screen.queryByRole("link", { name: "Water plants" })).toBeNull());
    expect(filter.getAttribute("aria-pressed")).toBe("true");
    expect(
      calls.some(
        (c) =>
          c.path.includes("projectId=inbox") &&
          c.path.includes("limit=500") &&
          c.path.includes("actionNeeded=true"),
      ),
    ).toBe(true);
  });
});
