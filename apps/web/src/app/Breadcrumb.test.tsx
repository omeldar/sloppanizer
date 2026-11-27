import { PROJECT_COLORS, type Project } from "@organizer/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTodo, type RecordedCall } from "../test/render.tsx";
import { renderAppAt } from "../test/renderApp.tsx";
import { breadcrumbTrail } from "./Breadcrumb.tsx";

// S5#8: every step of the breadcrumb except the page itself is a real link.

const T = "2026-11-01T09:00:00.000Z";
const NOT_FOUND = { status: 404, body: { error: { code: "not_found", message: "Not here." } } };

afterEach(() => vi.unstubAllGlobals());

const project: Project = {
  id: 1,
  slug: "extranet",
  name: "Extranet",
  description: "",
  color: PROJECT_COLORS[0],
  archivedAt: null,
  createdAt: T,
  updatedAt: T,
  openCount: 1,
};
const ref = { id: 1, slug: "extranet", name: "Extranet", color: PROJECT_COLORS[0] };
const subtask = makeTodo({
  id: 5,
  parentId: 4,
  projectId: 1,
  project: ref,
  parent: { id: 4, title: "Launch", status: "open" },
});

function renderAt(path: string) {
  return renderAppAt(path, (call: RecordedCall) => {
    const url = call.path.split("?")[0] ?? "";
    if (url === "/api/v1/projects") return { body: [project] };
    if (url === "/api/v1/todos/5") return { body: subtask };
    if (url === "/api/v1/todos") return { body: { items: [], total: 0, limit: 200, offset: 0 } };
    if (url === "/api/v1/labels") return { body: [] };
    return NOT_FOUND;
  });
}

const trail = () => screen.findByRole("list", { name: "Breadcrumb" }, { timeout: 5000 });

describe("breadcrumb links (S5#8)", () => {
  it("links a todo's project and parent, and leaves the todo itself as the page", async () => {
    const { router } = renderAt("/todos/5");
    const crumbs = await trail();
    const projectLink = await within(crumbs).findByRole("link", { name: "Extranet" });
    expect(projectLink.getAttribute("href")).toBe("/projects/extranet");
    expect(within(crumbs).getByRole("link", { name: "#4" }).getAttribute("href")).toBe("/todos/4");
    expect(within(crumbs).getByText("#5").getAttribute("aria-current")).toBe("page");
    expect(within(crumbs).getAllByRole("link")).toHaveLength(2);

    fireEvent.click(projectLink);
    await waitFor(() => expect(router.state.location.pathname).toBe("/projects/extranet"));
  });

  it("goes back to your own todos from a project page", async () => {
    const { router } = renderAt("/projects/extranet");
    const crumbs = await trail();
    await within(crumbs).findByText("Extranet");
    const home = within(crumbs).getByRole("link", { name: "My todos" });
    expect(home.getAttribute("href")).toBe("/");
    fireEvent.click(home);
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("leaves a shared project's tab for the account's own todos with a plain link", () => {
    const steps = breadcrumbTrail("/projects/extranet-shared", {
      projects: [{ slug: "extranet-shared", name: "Extranet Shared" }],
      todo: undefined,
      meetingName: undefined,
      home: { label: "My todos", href: "/u/lu/" },
    });
    expect(steps).toEqual([{ label: "My todos", href: "/u/lu/" }, { label: "Extranet Shared" }]);
  });

  it("links every step but the last on every page with a trail", () => {
    const context = {
      projects: [],
      todo: undefined,
      meetingName: "Standup",
      home: { label: "My todos", to: "/" },
    };
    for (const path of [
      "/meetings/3",
      "/notes/2",
      "/people/stats",
      "/people/9",
      "/settings/tokens",
      "/settings/files",
      "/projects/x",
      "/todos/7",
    ]) {
      const steps = breadcrumbTrail(path, context);
      const linked = steps.map((step) => Boolean(step.to ?? step.href));
      expect({ path, linked }).toEqual({ path, linked: steps.map((_, i) => i < steps.length - 1) });
      expect(steps.length).toBeGreaterThan(1);
    }
  });
});
