import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makePerson, type RecordedCall } from "../../test/render.tsx";
import { renderAppAt } from "../../test/renderApp.tsx";

// The route loads this page lazily. Loading it here, with the test file, keeps the import (and the
// editor) out of the first test's time limit.
await import("./PersonPage.tsx");

afterEach(() => vi.unstubAllGlobals());

// Rendering waits for the lazy route to resolve and the first queries to answer.
const LAZY_PAGE = { timeout: 5000 };

function renderPerson() {
  let person = makePerson("Dana", "Ärzte", 1);
  return renderAppAt("/people/1", ({ method, path, body }: RecordedCall) => {
    if (path === "/api/v1/people/1" && method === "PATCH") {
      const patch = body as { firstName: string; lastName: string };
      person = { ...person, ...patch, displayName: `${patch.firstName} ${patch.lastName}` };
      return { body: person };
    }
    if (path === "/api/v1/people/1") return { body: person };
    if (path.startsWith("/api/v1/topics")) return { body: [] };
    if (path.startsWith("/api/v1/todos?")) return { body: { items: [], total: 0, limit: 50, offset: 0 } };
    if (path.startsWith("/api/v1/teams") || path.startsWith("/api/v1/person-tags")) return { body: [] };
    if (path === "/api/v1/projects" || path === "/api/v1/labels") return { body: [] };
    return { status: 404, body: { error: { code: "not_found", message: "Not here." } } };
  });
}

describe("person page name", () => {
  it("edits first and last name in two labelled fields, umlauts included", async () => {
    const { calls } = renderPerson();
    fireEvent.click(await screen.findByRole("button", { name: "Dana Ärzte" }, LAZY_PAGE));
    // Visible labels, not only names for screen readers.
    expect(screen.getByText("First name").tagName).toBe("SPAN");
    expect(screen.getByText("Last name").tagName).toBe("SPAN");
    const first = screen.getByRole<HTMLInputElement>("textbox", { name: "First name" });
    // The first name is selected, so typing replaces it instead of adding to it.
    expect([first.selectionStart, first.selectionEnd]).toEqual([0, "Dana".length]);
    await userEvent.tab();
    await userEvent.keyboard("Ärztin{Enter}");
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
        firstName: "Dana",
        lastName: "Ärztin",
      }),
    );
    expect(await screen.findByRole("button", { name: "Dana Ärztin" })).toBeTruthy();
  });
});
