import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderAppAt } from "../../test/renderApp.tsx";

afterEach(() => vi.unstubAllGlobals());

const NO_HITS = { items: [], counts: { todo: 0, note: 0, comment: 0, person: 0 } };

function renderSearch(path: string) {
  return renderAppAt(path, ({ path: url }) => {
    if (url.startsWith("/api/v1/search")) {
      return { body: { q: new URL(url, "http://x").searchParams.get("q") ?? "", ...NO_HITS } };
    }
    if (url === "/api/v1/projects" || url === "/api/v1/labels") return { body: [] };
    return { status: 404, body: { error: { code: "not_found", message: "Not here." } } };
  });
}

describe("search page", () => {
  it("takes a new ?q= while it is open (the palette's Show all results) and keeps it", async () => {
    const { router, calls } = renderSearch("/search?q=old");
    const input = await screen.findByRole<HTMLInputElement>("textbox", { name: "Search" });
    expect(input.value).toBe("old");

    await act(() => router.navigate({ to: "/search", search: { q: "new" } }));

    expect(input.value).toBe("new");
    await waitFor(() => expect(calls.some((c) => c.path.includes("q=new"))).toBe(true));
    // Long past the typing pause: the old text did not come back.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(router.state.location.search).toEqual({ q: "new" });
    expect(input.value).toBe("new");
  });
});
