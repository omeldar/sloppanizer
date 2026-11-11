import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandsProvider, useCommands } from "../../app/commands.tsx";
import { makeTodo, mockApi, renderWithApp } from "../../test/render.tsx";
import { Palette } from "./Palette.tsx";

// cmdk measures its list and scrolls the selected item into view; jsdom has neither.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(() => vi.unstubAllGlobals());

function OpenPalette() {
  const { openPalette } = useCommands();
  useEffect(() => openPalette(), [openPalette]);
  return <Palette />;
}

function renderPalette() {
  mockApi(({ path }) => {
    if (path.includes("/projects")) return { body: [] };
    if (path.endsWith("/todos/42")) return { body: makeTodo({ id: 42, title: "Renew SSL certs" }) };
    if (/\/todos\/\d+$/.test(path))
      return {
        status: 404,
        body: { error: { code: "not_found", message: "There is no todo with this id." } },
      };
    return { body: { items: [], total: 0, limit: 8, offset: 0 } };
  });
  return renderWithApp(
    <CommandsProvider>
      <OpenPalette />
    </CommandsProvider>,
  );
}

describe("Palette search by #id", () => {
  it("shows the title of the todo behind the number and opens it", async () => {
    const { router } = renderPalette();
    await userEvent.type(await screen.findByRole("combobox"), "#42");
    const option = await screen.findByRole("option", { name: /#42/ });
    expect(await screen.findByText("Renew SSL certs")).toBeTruthy();
    expect(option.textContent).toContain("Inbox");
    await userEvent.keyboard("{Enter}");
    expect(router.state.location.pathname).toBe("/todos/42");
  });

  it("says when no todo has the number", async () => {
    renderPalette();
    await userEvent.type(await screen.findByRole("combobox"), "#7");
    expect(await screen.findByText("No todo with this number")).toBeTruthy();
  });
});
