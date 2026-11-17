import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecordedCall } from "../../test/render.tsx";
import { renderAppAt } from "../../test/renderApp.tsx";

// Page Up and Page Down switch the week on the two pages that show one: the week board and the planner.

afterEach(() => vi.unstubAllGlobals());

/** An empty account: no todos, no blocks. */
const emptyApi = ({ path }: RecordedCall) => {
  if (path.startsWith("/api/v1/todos")) return { body: { items: [], total: 0, limit: 200, offset: 0 } };
  if (path.startsWith("/api/v1/blocks")) return { body: [] };
  if (path.startsWith("/api/v1/next")) return { body: { items: [] } };
  if (path === "/api/v1/projects" || path === "/api/v1/labels") return { body: [] };
  return { status: 404, body: { error: { code: "not_found", message: "Not here." } } };
};

const press = (key: string, target: Element | Window = window, mods: KeyboardEventInit = {}) =>
  fireEvent.keyDown(target, { key, ...mods });

const MODIFIERS = [{ ctrlKey: true }, { metaKey: true }, { altKey: true }];

describe("Page Up and Page Down on the week board", () => {
  it("go to the previous and the next week", async () => {
    const { router } = renderAppAt("/week?start=2026-06-01", emptyApi);
    await screen.findByRole("heading", { name: "Week" });
    press("PageDown");
    await waitFor(() => expect(router.state.location.search).toEqual({ start: "2026-06-08" }));
    press("PageUp");
    await waitFor(() => expect(router.state.location.search).toEqual({ start: "2026-06-01" }));
    press("PageUp");
    await waitFor(() => expect(router.state.location.search).toEqual({ start: "2026-05-25" }));
  });

  it("leave the week alone while typing in a text field", async () => {
    const { router } = renderAppAt("/week?start=2026-06-01", emptyApi);
    await screen.findByRole("heading", { name: "Week" });
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    press("PageDown", field);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(router.state.location.search).toEqual({ start: "2026-06-01" });
    field.remove();
  });

  it("leave the week alone while a dialog is open", async () => {
    const { router } = renderAppAt("/week?start=2026-06-01", emptyApi);
    await screen.findByRole("heading", { name: "Week" });
    press("?");
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    press("PageDown", document.body);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(router.state.location.search).toEqual({ start: "2026-06-01" });
  });

  it("are listed in the shortcuts help", async () => {
    renderAppAt("/week?start=2026-06-01", emptyApi);
    await screen.findByRole("heading", { name: "Week" });
    press("?");
    const help = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(help.textContent).toContain("PgUp");
    expect(help.textContent).toContain("PgDn");
  });
});

describe("Page Up and Page Down on the planner", () => {
  it("go to the previous and the next week, keeping the weekday", async () => {
    const { router } = renderAppAt("/planner?day=2026-06-03", emptyApi);
    await screen.findByRole("heading", { name: "Planner" });
    press("PageDown");
    await waitFor(() => expect(router.state.location.search).toEqual({ day: "2026-06-10" }));
    press("PageUp");
    await waitFor(() => expect(router.state.location.search).toEqual({ day: "2026-06-03" }));
    press("PageUp");
    await waitFor(() => expect(router.state.location.search).toEqual({ day: "2026-05-27" }));
  });

  it("leave the week alone while the plan dialog is open", async () => {
    const { router } = renderAppAt("/planner?day=2026-06-03", emptyApi);
    await screen.findByRole("heading", { name: "Planner" });
    fireEvent.click(screen.getByRole("button", { name: "Plan time" }));
    const field = await screen.findByRole("textbox", { name: "Or a title" });
    press("PageDown", field);
    press("PageDown", document.body);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(router.state.location.search).toEqual({ day: "2026-06-03" });
  });
});

describe("Page Up and Page Down with a modifier key", () => {
  it.each(MODIFIERS)("keep the week board on its week with %o (the browser's own shortcut)", async (mods) => {
    const { router } = renderAppAt("/week?start=2026-06-01", emptyApi);
    await screen.findByRole("heading", { name: "Week" });
    press("PageDown", window, mods);
    press("PageUp", window, mods);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(router.state.location.search).toEqual({ start: "2026-06-01" });
  });

  it.each(MODIFIERS)("keep the planner on its week with %o", async (mods) => {
    const { router } = renderAppAt("/planner?day=2026-06-03", emptyApi);
    await screen.findByRole("heading", { name: "Planner" });
    press("PageDown", window, mods);
    press("PageUp", window, mods);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(router.state.location.search).toEqual({ day: "2026-06-03" });
  });

  it("jump a week over a month and year border on the planner", async () => {
    const { router } = renderAppAt("/planner?day=2026-12-30", emptyApi);
    await screen.findByRole("heading", { name: "Planner" });
    press("PageDown");
    await waitFor(() => expect(router.state.location.search).toEqual({ day: "2027-01-06" }));
  });

  it("leave the planner alone while typing in a text field", async () => {
    const { router } = renderAppAt("/planner?day=2026-06-03", emptyApi);
    await screen.findByRole("heading", { name: "Planner" });
    const field = document.createElement("textarea");
    document.body.append(field);
    field.focus();
    press("PageUp", field);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(router.state.location.search).toEqual({ day: "2026-06-03" });
    field.remove();
  });
});
