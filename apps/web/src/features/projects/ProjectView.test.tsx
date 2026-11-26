import { type AccountProfile, PROJECT_COLORS, type Project, type ProjectView } from "@organizer/shared";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecordedCall } from "../../test/render.tsx";
import { renderAppAt } from "../../test/renderApp.tsx";

await import("./ProjectPage.tsx");

// S5#3: a project page opens as the account chose in Settings, unless its address says ?view=.

const LAZY_PAGE = { timeout: 5000 };
const T = "2026-11-01T09:00:00.000Z";
const NOT_FOUND = { status: 404, body: { error: { code: "not_found", message: "Not here." } } };

afterEach(() => vi.unstubAllGlobals());

const project: Project = {
  id: 1,
  slug: "module",
  name: "Module",
  description: "",
  color: PROJECT_COLORS[0],
  archivedAt: null,
  createdAt: T,
  updatedAt: T,
  openCount: 0,
};

const profile = (projectView: ProjectView): AccountProfile => ({
  id: 1,
  username: "lu",
  displayName: "Lu",
  firstName: "",
  lastName: "",
  dateFormat: "dmy.",
  timeFormat: "24h",
  projectView,
  omeldarLinked: false,
  color: PROJECT_COLORS[0],
  role: "user",
  timeZone: "Europe/Zurich",
  createdAt: T,
  security: {
    password: true,
    passwordChangedAt: T,
    totpSince: T,
    passkeys: 0,
    recoveryCodesLeft: 10,
    loginResetAt: null,
  },
});

function renderProject(view: ProjectView | null, path = "/projects/module") {
  return renderAppAt(path, (call: RecordedCall) => {
    const url = call.path.split("?")[0] ?? "";
    if (url === "/api/v1/account") return view ? { body: profile(view) } : NOT_FOUND;
    if (url === "/api/v1/projects") return { body: [project] };
    if (url === "/api/v1/todos") return { body: { items: [], total: 0, limit: 200, offset: 0 } };
    if (url === "/api/v1/labels") return { body: [] };
    return NOT_FOUND;
  });
}

const pressed = (name: string) =>
  screen.getByRole("button", { name }).getAttribute("aria-pressed") === "true";
const boardShown = () => screen.queryByRole("region", { name: "In progress" }) !== null;

describe("the view a project opens in", () => {
  it("opens as a board when the account chose the board", async () => {
    renderProject("board");
    await screen.findByRole("region", { name: "In progress" }, LAZY_PAGE);
    expect(pressed("Board")).toBe(true);
    expect(pressed("List")).toBe(false);
  });

  it.each([
    ["chose the list", "list"],
    ["choice cannot be read", null],
  ] as const)("opens as a list when the account's %s", async (_name, view) => {
    renderProject(view);
    await screen.findByRole("button", { name: "Edit project" }, LAZY_PAGE);
    expect(pressed("List")).toBe(true);
    expect(boardShown()).toBe(false);
  });

  it("follows the address over the account's choice, and the switch sets the address only off the default", async () => {
    const { router } = renderProject("board", "/projects/module?view=list");
    await screen.findByRole("button", { name: "Edit project" }, LAZY_PAGE);
    expect(pressed("List")).toBe(true);
    expect(boardShown()).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    await screen.findByRole("region", { name: "In progress" });
    expect(router.state.location.search).toEqual({});

    fireEvent.click(screen.getByRole("button", { name: "List" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ view: "list" }));
    expect(boardShown()).toBe(false);
  });
});
