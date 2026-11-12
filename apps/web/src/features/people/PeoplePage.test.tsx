import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makePerson } from "../../test/render.tsx";
import { renderAppAt } from "../../test/renderApp.tsx";

afterEach(() => vi.unstubAllGlobals());

describe("people filter", () => {
  it("asks the server once typing pauses and keeps the text in the URL", async () => {
    const { router, calls } = renderAppAt("/people", ({ path }) => {
      if (path.startsWith("/api/v1/people")) return { body: [makePerson("Anna", "Meier")] };
      if (path.startsWith("/api/v1/teams") || path.startsWith("/api/v1/person-tags")) return { body: [] };
      if (path === "/api/v1/projects" || path === "/api/v1/labels") return { body: [] };
      return { status: 404, body: { error: { code: "not_found", message: "Not here." } } };
    });
    const filter = await screen.findByRole("textbox", { name: "Search people" });
    // About 60 ms per key: faster than the typing pause, slow enough for each URL change to land.
    for (const text of ["a", "an", "ann"]) {
      fireEvent.change(filter, { target: { value: text } });
      // oxlint-disable-next-line no-await-in-loop -- typing, one key after the other
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    await waitFor(() => expect(router.state.location.search).toEqual({ q: "ann" }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const searches = calls.filter((c) => c.path.startsWith("/api/v1/people?") && c.path.includes("q="));
    expect(searches.map((c) => new URL(c.path, "http://x").searchParams.get("q"))).toEqual(["ann"]);
  });
});
