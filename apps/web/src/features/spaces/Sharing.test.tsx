import { PROJECT_COLORS, type Space } from "@organizer/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountProvider } from "../../app/account.tsx";
import type { StoredAccount } from "../../lib/accounts.ts";
import { setSpace } from "../../lib/api.ts";
import { headersOf, makeTodo, mockApi, renderWithApp } from "../../test/render.tsx";
import { TodoProjectPicker } from "../todos/TodoProjectPicker.tsx";
import { SpaceDialog } from "./SpaceDialogs.tsx";

// S5#7: a sharing view that says who has access, and moving a todo into a shared project.

const T = "2026-11-01T09:00:00.000Z";
const NOT_FOUND = { status: 404, body: { error: { code: "not_found", message: "Not here." } } };

const anna: StoredAccount = {
  accountId: 1,
  username: "anna",
  displayName: "Anna",
  color: "#2EC5CE",
  role: "user",
  sessionId: "s",
  refreshToken: "r",
  addedAt: T,
  signedOut: false,
};

const space: Space = {
  id: 7,
  name: "Extranet",
  color: PROJECT_COLORS[0],
  system: null,
  projectSlug: "extranet",
  openCount: 2,
  role: "owner",
  members: [{ accountId: 1, username: "anna", name: "Anna Berg", role: "owner", addedAt: T }],
  createdAt: T,
};
const withBo: Space = {
  ...space,
  members: [
    ...space.members,
    { accountId: 2, username: "bobo", name: "Bo Lind", role: "member", addedAt: "2026-11-26T09:00:00.000Z" },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSpace(null);
});

describe("sharing a project (S5#7)", () => {
  it("lists who has access with their role, and says who was added or is unknown", async () => {
    let current = space;
    const calls = mockApi(({ method, path, body }) => {
      if (path.startsWith("/api/v1/users")) return { body: [] };
      if (method === "POST" && path === "/api/v1/spaces/7/members") {
        if ((body as { username: string }).username === "nobody") {
          return {
            status: 404,
            body: {
              error: {
                code: "not_found",
                message: 'No active account is called "nobody". Check the username.',
              },
            },
          };
        }
        current = withBo;
        return { body: withBo };
      }
      if (path === "/api/v1/spaces") return { body: [current] };
      return NOT_FOUND;
    });
    renderWithApp(
      <AccountProvider account={anna}>
        <SpaceDialog space={space} onOpenChange={() => {}} />
      </AccountProvider>,
    );
    const list = await screen.findByRole("list", { name: "People with access" });
    expect(within(list).getByText(/Anna Berg/).textContent).toContain("(you)");
    expect(within(list).getByText("Owner")).toBeTruthy();
    expect(within(list).queryByRole("button", { name: "Remove anna" })).toBeNull();

    const field = screen.getByRole("textbox", { name: "Username to add" });
    await userEvent.type(field, "nobody{Enter}");
    expect((await screen.findByRole("alert")).textContent).toBe(
      'No active account is called "nobody". Check the username.',
    );

    await userEvent.clear(field);
    await userEvent.type(field, "@bobo anna{Enter}");
    const status = await screen.findByRole("status");
    expect(status.textContent).toBe(
      "Added Bo Lind (@bobo). Extranet is under Shared in their sidebar now. @anna already has access.",
    );
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([
      { username: "nobody" },
      { username: "bobo" },
    ]);
  });

  it("shows members as members, with a Remove for the owner", async () => {
    mockApi(({ path }) => (path === "/api/v1/spaces" ? { body: [withBo] } : NOT_FOUND));
    renderWithApp(
      <AccountProvider account={anna}>
        <SpaceDialog space={withBo} onOpenChange={() => {}} />
      </AccountProvider>,
    );
    const list = await screen.findByRole("list", { name: "People with access" });
    const bo = within(list)
      .getByText(/Bo Lind/)
      .closest("li") as HTMLElement;
    expect(within(bo).getByText("Member")).toBeTruthy();
    expect(within(bo).getByText(/since/)).toBeTruthy();
    expect(within(bo).getByRole("button", { name: "Remove bobo" })).toBeTruthy();
  });
});

describe("moving a todo to a shared project (S5#7)", () => {
  // The picker (cmdk) measures its list.
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

  it("lists the shared projects in the project picker and moves the todo after a confirmation", async () => {
    const assign = vi.fn<(href: string) => void>();
    vi.stubGlobal("location", { ...window.location, assign });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const todo = makeTodo({ id: 12, title: "Launch" });
    const calls = mockApi(({ method, path }) => {
      if (path === "/api/v1/spaces") return { body: [space] };
      if (path === "/api/v1/projects") return { body: [] };
      if (method === "POST" && path === "/api/v1/todos/12/move") {
        return {
          body: {
            spaceId: 7,
            ref: "S7#3",
            todo: makeTodo({ id: 3, title: "Launch" }),
            original: makeTodo({ id: 12, title: "Launch", status: "done" }),
          },
        };
      }
      return NOT_FOUND;
    });
    const onPick = vi.fn<(projectId: number | null) => void>();
    renderWithApp(
      <AccountProvider account={anna}>
        <TodoProjectPicker todo={todo} onPick={onPick} />
      </AccountProvider>,
    );
    const option = await screen.findByRole("option", { name: /Extranet/ });
    expect(option.textContent).toContain("shared");
    await userEvent.click(option);
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]?.[0]).toContain('Move "Launch" to Extranet?');
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/u/anna/shared/7/todos/3"));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ spaceId: 7 });
    expect(onPick).not.toHaveBeenCalled();
  });

  it("offers your own projects inside a shared project's tab, and does nothing when not confirmed", async () => {
    setSpace(7);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const calls = mockApi((call) => {
      const { path } = call;
      if (path === "/api/v1/spaces") return { body: [space] };
      // Inside the shared project's tab its own projects; your own ones are asked for as yourself.
      if (path === "/api/v1/projects" && headersOf(call)["x-sloppanizer-space"]) return { body: [] };
      if (path === "/api/v1/projects")
        return {
          body: [
            {
              id: 4,
              slug: "work",
              name: "Work",
              description: "",
              color: PROJECT_COLORS[1],
              archivedAt: null,
              createdAt: T,
              updatedAt: T,
              openCount: 0,
            },
          ],
        };
      return NOT_FOUND;
    });
    renderWithApp(
      <AccountProvider account={anna}>
        <TodoProjectPicker todo={makeTodo({ id: 3 })} onPick={() => {}} />
      </AccountProvider>,
    );
    const work = await screen.findByRole("option", { name: /Work/ });
    expect(work.textContent).toContain("my todos");
    expect(screen.getByRole("option", { name: /My Inbox/ })).toBeTruthy();
    // The project it is already in is not offered as a move.
    expect(screen.queryByRole("option", { name: /Extranet/ })).toBeNull();
    await userEvent.click(work);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});
