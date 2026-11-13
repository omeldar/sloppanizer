import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makePerson, type RecordedCall } from "../../test/render.tsx";
import { renderAppAt } from "../../test/renderApp.tsx";

// The route loads this page lazily. Loading it here, with the test file, keeps the import (and the
// editor) out of the first test's time limit.
await import("./PersonPage.tsx");

afterEach(() => vi.unstubAllGlobals());

const person = makePerson("Anna", "Meier", 1, { topics: ["DNS", "Backup"] });

/** The person page; the page's topic list knows DNS but not Backup (as if past its limit). */
function renderPerson() {
  return renderAppAt("/people/1", ({ path }: RecordedCall) => {
    if (path === "/api/v1/people/1") return { body: person };
    if (path.startsWith("/api/v1/topics?")) {
      const q = new URL(path, "http://x").searchParams.get("q");
      if (q === "Backup") return { body: [{ id: 9, name: "Backup", peopleCount: 1 }] };
      if (q === null) return { body: [{ id: 7, name: "DNS", peopleCount: 3 }] };
      return { body: [] };
    }
    if (path.startsWith("/api/v1/todos?")) return { body: { items: [], total: 0, limit: 50, offset: 0 } };
    if (path.startsWith("/api/v1/teams") || path.startsWith("/api/v1/person-tags")) return { body: [] };
    if (path === "/api/v1/projects" || path === "/api/v1/labels") return { body: [] };
    return { status: 404, body: { error: { code: "not_found", message: "Not here." } } };
  });
}

// Rendering waits for the lazy route to resolve and the first queries to answer.
const LAZY_PAGE = { timeout: 5000 };

const topicCalls = (calls: RecordedCall[]) => calls.filter((c) => c.path.startsWith("/api/v1/topics"));

describe("person page topics", () => {
  it("loads the topics once for all chips instead of once per chip", async () => {
    const { calls } = renderPerson();
    await screen.findByRole("button", { name: "Topic Backup, open menu" }, LAZY_PAGE);
    await waitFor(() => expect(topicCalls(calls)).toHaveLength(1));
    expect(topicCalls(calls)[0]?.path).toBe("/api/v1/topics?limit=200");
  });

  it("renames a topic that is not in the page's list by looking it up when picked", async () => {
    const { calls } = renderPerson();
    const chip = await screen.findByRole("button", { name: "Topic Backup, open menu" }, LAZY_PAGE);
    await waitFor(() => expect(topicCalls(calls)).toHaveLength(1));
    fireEvent.keyDown(chip, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename topic for everyone" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename Backup" });
    expect(within(dialog).getByRole<HTMLInputElement>("textbox", { name: /New name/ }).value).toBe("Backup");
    expect(topicCalls(calls).map((c) => c.path)).toContain("/api/v1/topics?q=Backup&limit=20");
  });
});
