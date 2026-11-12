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

const hit = (kind: string, id: number, title: string, extra: object = {}) => ({
  kind,
  id,
  title,
  snippet: "",
  highlights: [],
  todoId: kind === "todo" ? id : null,
  status: kind === "todo" ? "open" : null,
  subtitle: null,
  ...extra,
});

const SEARCH = {
  q: "firewall",
  items: [
    hit("todo", 3, "Open the firewall for the NAS"),
    hit("note", 2, "Network layout", { snippet: "the firewall sits in front", highlights: [[4, 12]] }),
    hit("comment", 9, "Renew SSL certs", {
      todoId: 5,
      snippet: "asked about the firewall",
      highlights: [[16, 24]],
    }),
    hit("person", 4, "Luca Brunner", { subtitle: "Network team, Firewall rules" }),
  ],
  counts: { todo: 1, note: 1, comment: 1, person: 1 },
};

function renderPalette() {
  mockApi(({ path }) => {
    if (path.includes("/projects")) return { body: [] };
    if (path.startsWith("/api/v1/search")) return { body: SEARCH };
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

describe("Palette search", () => {
  it("groups server results by kind with the matches marked", async () => {
    renderPalette();
    await userEvent.type(await screen.findByRole("combobox"), "firewall");
    await screen.findByText("People");
    for (const heading of ["Todos", "Notes", "Comments"]) expect(screen.getByText(heading)).toBeTruthy();
    expect(screen.getAllByText("firewall").every((mark) => mark.tagName === "MARK")).toBe(true);
    expect(screen.getByText("Network team, Firewall rules")).toBeTruthy();
    expect(screen.getByRole("option", { name: /Show all results/ }).textContent).toContain("4 found");
  });

  it("opens a comment on its todo, scrolled to the comment", async () => {
    const { router } = renderPalette();
    await userEvent.type(await screen.findByRole("combobox"), "firewall");
    await userEvent.click(await screen.findByRole("option", { name: /asked about the/ }));
    expect(router.state.location.pathname).toBe("/todos/5");
    expect(router.state.location.search).toEqual({ comment: 9 });
  });

  it("does not search for a single character", async () => {
    renderPalette();
    await userEvent.type(await screen.findByRole("combobox"), "f");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(screen.queryByText("Comments")).toBeNull();
  });
});
