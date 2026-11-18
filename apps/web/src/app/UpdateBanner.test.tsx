import type { Project } from "@organizer/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/apiError.ts";
import {
  duringUpdate,
  setServerVersion,
  UPDATING_MESSAGE,
  versionGapNow,
  WEB_VERSION,
} from "../lib/serverVersion.ts";
import type { RecordedCall } from "../test/render.tsx";
import { renderAppAt } from "../test/renderApp.tsx";

await import("../features/projects/ProjectPage.tsx");

const LAZY_PAGE = { timeout: 5000 };
const T = "2026-11-01T09:00:00.000Z";
const NOT_FOUND = { status: 404, body: { error: { code: "not_found", message: "Not here." } } };
const unknownRoute = (method: string, path: string) => ({
  status: 404,
  body: {
    error: { code: "not_found", message: `${method} ${path} does not exist. See /api/docs for the API.` },
  },
});

/** A version of the same major release, `minor` and `patch` steps from the web app's own. */
function shifted(minor: number, patch = 0): string {
  const [major = 0, own = 0] = WEB_VERSION.split(".").map(Number);
  return minor < 0 && own === 0 ? `${major - 1}.99.0` : `${major}.${own + minor}.${patch}`;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setServerVersion(null);
});

const project: Project = {
  id: 1,
  slug: "module",
  name: "Module",
  description: "",
  color: "#A77BF3",
  archivedAt: null,
  createdAt: T,
  updatedAt: T,
  openCount: 0,
};

/** The app at a project page; the fake server reports `version.current` on its health route. */
function renderWithServer(version: { current: string }) {
  return renderAppAt("/projects/module", (call: RecordedCall) => {
    const url = call.path.split("?")[0] ?? "";
    if (url === "/api/v1/health") return { body: { ok: true, version: version.current } };
    if (url === "/api/v1/projects") return { body: [project] };
    if (url === "/api/v1/projects/1" && call.method === "PATCH") return unknownRoute("PATCH", url);
    if (url === "/api/v1/todos") return { body: { items: [], total: 0 } };
    if (url === "/api/v1/labels") return { body: [] };
    return NOT_FOUND;
  });
}

describe("update banner", () => {
  it("says the server is updating, and goes away by itself once the server reports the new release", async () => {
    const server = { current: shifted(-1) };
    const { client } = renderWithServer(server);
    expect(
      await screen.findByText(
        "Sloppanizer is updating. Some things may not work for a few minutes.",
        {},
        LAZY_PAGE,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();

    server.current = WEB_VERSION;
    await client.refetchQueries({ queryKey: ["serverVersion"] });
    await waitFor(() => expect(screen.queryByText(/Sloppanizer is updating/)).toBeNull());
  });

  it("says nothing while both run the same release (fix releases: see versionGap in shared)", async () => {
    renderWithServer({ current: WEB_VERSION });
    await screen.findByRole("button", { name: "Edit project" }, LAZY_PAGE);
    await waitFor(() => expect(versionGapNow()).toBe("same"));
    expect(screen.queryByText(/Sloppanizer is updating|new version of Sloppanizer/)).toBeNull();
  });

  it("offers a reload when the server runs a newer release than this page", async () => {
    const reload = vi.fn<() => void>();
    vi.stubGlobal("location", { ...window.location, reload });
    renderWithServer({ current: shifted(0, 1) });
    expect(await screen.findByText("A new version of Sloppanizer is ready.", {}, LAZY_PAGE)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("shows a feature the old server does not have yet as 'in a few minutes', not 'does not exist'", async () => {
    renderWithServer({ current: shifted(-1) });
    await screen.findByText(/Sloppanizer is updating/, {}, LAZY_PAGE);
    fireEvent.click(await screen.findByRole("button", { name: "Edit project" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit project" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "#36B37E" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(UPDATING_MESSAGE);
  });
});

describe("duringUpdate", () => {
  const unknown = new ApiError(
    404,
    "not_found",
    "POST /api/v1/recurring does not exist. See /api/docs for the API.",
  );
  const record = new ApiError(404, "not_found", "Todo 5 does not exist. Check the id.");
  const newField = new ApiError(
    422,
    "validation_failed",
    'Invalid request. body: Unrecognized key: "series"',
  );
  const realInput = new ApiError(
    422,
    "validation_failed",
    "Invalid request. body.name: Give the project a name.",
  );

  it("rewrites only what an older server answers to new features, and only while it is updating", () => {
    setServerVersion(shifted(-1));
    expect(duringUpdate(unknown).message).toBe(UPDATING_MESSAGE);
    expect(duringUpdate(newField).message).toBe(UPDATING_MESSAGE);
    expect(duringUpdate(record)).toBe(record);
    expect(duringUpdate(realInput)).toBe(realInput);

    setServerVersion(WEB_VERSION);
    expect(duringUpdate(unknown)).toBe(unknown);
  });
});
