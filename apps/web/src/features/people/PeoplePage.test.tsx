import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makePerson, typeOnFakeClock } from "../../test/render.tsx";
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
    // 60 ms per key: faster than the 150 ms typing pause, slow enough for each render to land.
    await typeOnFakeClock(filter, ["a", "an", "ann"], 60, 150);
    await waitFor(() => expect(router.state.location.search).toEqual({ q: "ann" }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const searches = calls.filter((c) => c.path.startsWith("/api/v1/people?") && c.path.includes("q="));
    expect(searches.map((c) => new URL(c.path, "http://x").searchParams.get("q"))).toEqual(["ann"]);
  });
});

describe("new person dialog", () => {
  it("sends the picked languages with the new person", async () => {
    const created = makePerson("Lena", "Graf", 5, { languages: ["de", "en"] });
    const { calls } = renderAppAt("/people", ({ method, path }) => {
      if (method === "POST" && path === "/api/v1/people") return { status: 201, body: created };
      if (path === "/api/v1/people/5") return { body: created };
      if (path.startsWith("/api/v1/people")) return { body: [] };
      if (path.startsWith("/api/v1/teams") || path.startsWith("/api/v1/person-tags")) return { body: [] };
      if (path.startsWith("/api/v1/topics") || path.startsWith("/api/v1/stats")) return { body: [] };
      if (path.startsWith("/api/v1/todos?")) return { body: { items: [], total: 0, limit: 50, offset: 0 } };
      if (path === "/api/v1/projects" || path === "/api/v1/labels") return { body: [] };
      return { status: 404, body: { error: { code: "not_found", message: "Not here." } } };
    });
    fireEvent.click(await screen.findByRole("button", { name: "New person" }));
    const dialog = await screen.findByRole("dialog", { name: "New person" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "First name" }), {
      target: { value: "Lena" },
    });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Last name" }), {
      target: { value: "Graf" },
    });
    const languages = within(dialog).getByRole("group", { name: "Languages" });
    const english = within(languages).getByRole("button", { name: "English" });
    const german = within(languages).getByRole("button", { name: "German" });
    expect([german, english].map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false"]);
    fireEvent.click(english);
    fireEvent.click(german);
    expect([german, english].map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "true"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Add person" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
      firstName: "Lena",
      lastName: "Graf",
      languages: ["de", "en"],
    });
  });
});
