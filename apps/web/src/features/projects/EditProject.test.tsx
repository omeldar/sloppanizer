import { PROJECT_COLORS, type Project } from "@organizer/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecordedCall } from "../../test/render.tsx";
import { renderAppAt } from "../../test/renderApp.tsx";
import { projectPatch } from "./EditProjectDialog.tsx";
import { freeProjectColor } from "./NewProjectDialog.tsx";

await import("./ProjectPage.tsx");

const LAZY_PAGE = { timeout: 5000 };
const T = "2026-11-01T09:00:00.000Z";
const PURPLE = "#A77BF3";
const NOT_FOUND = { status: 404, body: { error: { code: "not_found", message: "Not here." } } };

afterEach(() => vi.unstubAllGlobals());

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 1,
    slug: "module",
    name: "Module",
    description: "",
    color: PURPLE,
    archivedAt: null,
    createdAt: T,
    updatedAt: T,
    openCount: 0,
    ...overrides,
  };
}

/** Projects kept by the fake server, so a PATCH shows on the next list. */
function renderProjects(start: Project[], path = "/projects/module") {
  let projects = [...start];
  return renderAppAt(path, (call: RecordedCall) => {
    const url = call.path.split("?")[0] ?? "";
    if (url === "/api/v1/projects") return { body: projects };
    const one = /^\/api\/v1\/projects\/(\d+)$/.exec(url);
    if (one && call.method === "PATCH") {
      const id = Number(one[1]);
      projects = projects.map((p) => (p.id === id ? { ...p, ...(call.body as Partial<Project>) } : p));
      return { body: projects.find((p) => p.id === id) };
    }
    if (url === "/api/v1/todos") return { body: { items: [], total: 0 } };
    if (url === "/api/v1/labels") return { body: [] };
    return NOT_FOUND;
  });
}

describe("editing a project", () => {
  it("changes the color from the project page and sends only what changed", async () => {
    const { calls } = renderProjects([
      makeProject(),
      makeProject({ id: 2, slug: "org", name: "Organizational" }),
    ]);
    fireEvent.click(await screen.findByRole("button", { name: "Edit project" }, LAZY_PAGE));
    const dialog = await screen.findByRole("dialog", { name: "Edit project" });
    expect((within(dialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Module");
    expect((within(dialog).getByRole("radio", { name: PURPLE }) as HTMLInputElement).checked).toBe(true);

    fireEvent.click(within(dialog).getByRole("radio", { name: "#36B37E" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit project" })).toBeNull());
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches.map((c) => [c.path, c.body])).toEqual([["/api/v1/projects/1", { color: "#36B37E" }]]);
  });

  it("opens from the project's menu in the sidebar, with name and description", async () => {
    const { calls } = renderProjects([makeProject({ description: "Lecture notes" })], "/");
    fireEvent.click(await screen.findByRole("button", { name: "More for Module" }, LAZY_PAGE));
    // Radix opens the menu on pointer down; keyboard Enter works the same in jsdom.
    fireEvent.keyDown(screen.getByRole("button", { name: "More for Module" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit project" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit project" });
    const description = within(dialog).getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement;
    expect(description.value).toBe("Lecture notes");

    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: " Uni " } });
    fireEvent.change(description, { target: { value: "" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ name: "Uni", description: "" });
    expect(await screen.findByRole("link", { name: /Uni/ })).toBeTruthy();
  });
});

describe("projectPatch", () => {
  const project = { name: "Module", description: "", color: PURPLE };

  it("is empty when nothing changed, also for a color in other case", () => {
    expect(projectPatch(project, { name: " Module ", description: "", color: PURPLE.toLowerCase() })).toEqual(
      {},
    );
  });
});

describe("freeProjectColor", () => {
  it("picks the first color no project uses yet, grey last", () => {
    expect(freeProjectColor([])).toBe(PROJECT_COLORS[1]);
    expect(freeProjectColor([{ color: "#4c9aff" }, { color: "#36B37E" }])).toBe("#FFB224");
    const allButGrey = PROJECT_COLORS.slice(1).map((color) => ({ color }));
    expect(freeProjectColor(allButGrey)).toBe(PROJECT_COLORS[0]);
    expect(freeProjectColor(PROJECT_COLORS.map((color) => ({ color })))).toBe(PROJECT_COLORS[1]);
  });
});
