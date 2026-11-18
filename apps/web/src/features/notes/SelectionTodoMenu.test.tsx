import type { Note } from "@organizer/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTodo, type RecordedCall } from "../../test/render.tsx";
import { renderAppAt } from "../../test/renderApp.tsx";

// The route loads this page lazily; loading it with the test file keeps it out of the first test's limit.
await import("./NotesPage.tsx");

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  vi.unstubAllGlobals();
});

const T = "2026-11-01T09:00:00.000Z";
const LAZY_PAGE = { timeout: 5000 };

const note: Note = {
  id: 1,
  projectId: null,
  project: null,
  title: "Planning",
  bodyMd: "Call Anna about\nthe VPN rollout\n\nOther thoughts.",
  pinnedAt: null,
  createdBy: "you",
  createdAt: T,
  updatedAt: T,
};

function renderNote() {
  return renderAppAt("/notes/1", ({ method, path }: RecordedCall) => {
    if (method === "POST" && path === "/api/v1/todos") return { status: 201, body: makeTodo({ id: 42 }) };
    if (path === "/api/v1/notes/1") return { body: note };
    if (path.startsWith("/api/v1/notes")) return { body: { items: [], total: 0, limit: 500, offset: 0 } };
    if (path === "/api/v1/projects" || path === "/api/v1/labels") return { body: [] };
    return { status: 404, body: { error: { code: "not_found", message: "Not here." } } };
  });
}

/** Selects the first paragraph of the preview, as a mouse drag or a long press would. */
async function selectFirstParagraph() {
  const paragraph = await screen.findByText(/Call Anna about/, {}, LAZY_PAGE);
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  const selection = document.getSelection() as Selection;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

const posts = (calls: RecordedCall[]) => calls.filter((c) => c.method === "POST");

describe("todo from selected note text", () => {
  it("shows no menu and opens nothing without a selection", async () => {
    renderNote();
    await screen.findByText(/Call Anna about/, {}, LAZY_PAGE);
    document.dispatchEvent(new Event("selectionchange"));
    fireEvent.keyDown(window, { key: "T", altKey: true, shiftKey: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("button", { name: "Create Issue - Title" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "New todo" })).toBeNull();
  });

  it("hides the menu again when the selection goes away", async () => {
    renderNote();
    await selectFirstParagraph();
    await screen.findByRole("button", { name: "Create Issue - Title" });
    document.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Create Issue - Title" })).toBeNull());
  });

  it("opens the new todo dialog with the selection as the title on one line, and cancel saves nothing", async () => {
    const { calls } = renderNote();
    await selectFirstParagraph();
    fireEvent.click(await screen.findByRole("button", { name: "Create Issue - Title" }));
    const dialog = await screen.findByRole("dialog", { name: "New todo" });
    expect(within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Title" }).value).toBe(
      "Call Anna about the VPN rollout",
    );
    expect(within(dialog).getByRole<HTMLTextAreaElement>("textbox", { name: "Notes" }).value).toBe("");
    // The other fields keep their defaults.
    expect(within(dialog).getByRole("button", { name: /Inbox/ })).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New todo" })).toBeNull());
    expect(posts(calls)).toEqual([]);
  });

  it("puts the selection into the description with its line break, and saves on confirm", async () => {
    const { calls } = renderNote();
    await selectFirstParagraph();
    fireEvent.click(await screen.findByRole("button", { name: "Create Issue - Description" }));
    const dialog = await screen.findByRole("dialog", { name: "New todo" });
    expect(within(dialog).getByRole<HTMLTextAreaElement>("textbox", { name: "Notes" }).value).toBe(
      "Call Anna about\nthe VPN rollout",
    );
    const title = within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Title" });
    expect(title.value).toBe("");
    expect(posts(calls)).toEqual([]);
    fireEvent.change(title, { target: { value: "VPN rollout" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add todo" }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({
      path: "/api/v1/todos",
      body: { title: "VPN rollout", projectId: null, descriptionMd: "Call Anna about\nthe VPN rollout" },
    });
  });

  it("opens the dialog from the keyboard: Alt+Shift+T for the title, Alt+Shift+D for the description", async () => {
    renderNote();
    await selectFirstParagraph();
    await screen.findByRole("button", { name: "Create Issue - Title" });
    fireEvent.keyDown(window, { key: "T", altKey: true, shiftKey: true });
    let dialog = await screen.findByRole("dialog", { name: "New todo" });
    expect(within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Title" }).value).toBe(
      "Call Anna about the VPN rollout",
    );
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New todo" })).toBeNull());

    await selectFirstParagraph();
    await screen.findByRole("button", { name: "Create Issue - Description" });
    fireEvent.keyDown(window, { key: "D", altKey: true, shiftKey: true });
    dialog = await screen.findByRole("dialog", { name: "New todo" });
    expect(within(dialog).getByRole<HTMLTextAreaElement>("textbox", { name: "Notes" }).value).toBe(
      "Call Anna about\nthe VPN rollout",
    );
  });
});

describe("todo title from a long selection", () => {
  it("cuts the title to the limit and says so in the dialog", async () => {
    const long = "word ".repeat(80).trim();
    renderAppAt("/notes/1", ({ path }: RecordedCall) => {
      if (path === "/api/v1/notes/1") return { body: { ...note, bodyMd: long } };
      if (path.startsWith("/api/v1/notes")) return { body: { items: [], total: 0, limit: 500, offset: 0 } };
      if (path === "/api/v1/projects" || path === "/api/v1/labels") return { body: [] };
      return { status: 404, body: { error: { code: "not_found", message: "Not here." } } };
    });
    const paragraph = await screen.findByText(/^word word/, {}, LAZY_PAGE);
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    document.getSelection()?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    fireEvent.click(await screen.findByRole("button", { name: "Create Issue - Title" }));
    const dialog = await screen.findByRole("dialog", { name: "New todo" });
    const title = within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Title" }).value;
    expect(title.length).toBeLessThanOrEqual(300);
    expect(long.startsWith(title)).toBe(true);
    expect(within(dialog).getByRole("status").textContent).toContain(
      `The text had ${long.length} characters, more than a title holds. The title keeps the first 300.`,
    );
  });
});
