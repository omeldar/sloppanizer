import type { NextUp, Space } from "@organizer/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountProvider } from "../../app/account.tsx";
import type { StoredAccount } from "../../lib/accounts.ts";
import { headersOf, makeTodo, mockApi, renderWithApp } from "../../test/render.tsx";
import { AssignedToYou } from "./AssignedToYou.tsx";

const T = "2026-11-01T09:00:00.000Z";

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
  name: "Home move",
  color: "#4C9AFF",
  system: null,
  projectSlug: "home-move",
  openCount: 2,
  role: "member",
  members: [],
  createdAt: T,
};

const van = makeTodo({
  id: 3,
  title: "Book van",
  assignee: { accountId: 1, username: "anna", name: "Anna" },
});
const next: NextUp = {
  mode: "smart",
  today: "2026-11-11",
  generatedAt: T,
  items: [{ todo: van, score: 40, reasons: [] }],
  blocked: [],
};

afterEach(() => vi.unstubAllGlobals());

describe("Assigned to you", () => {
  it("lists todos assigned to you in shared projects, from where, and marks them done there", async () => {
    const calls = mockApi(({ method, path }) => {
      if (path.endsWith("/spaces")) return { body: [space] };
      if (path.includes("/next")) return { body: next };
      if (method === "PATCH") return { body: { ...van, status: "done" } };
      return { status: 404, body: { error: { code: "not_found", message: "no" } } };
    });
    renderWithApp(
      <AccountProvider account={anna}>
        <AssignedToYou />
      </AccountProvider>,
    );
    const section = await screen.findByRole("region", { name: "Assigned to you" });
    expect(within(section).getByText("from Home move")).toBeTruthy();
    // Opens in the shared project's own tab, where the todo lives.
    expect(within(section).getByRole("link", { name: "Book van" }).getAttribute("href")).toBe(
      "/u/anna/shared/7/todos/3",
    );
    const asked = calls.find((c) => c.path.includes("/next"));
    expect(asked?.path).toContain("assignee=me");
    expect(asked && headersOf(asked)["x-sloppanizer-space"]).toBe("7");

    await userEvent.click(within(section).getByRole("button", { name: 'Mark "Book van" done' }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch).toEqual({ method: "PATCH", path: "/api/v1/todos/3", body: { status: "done" } });
    expect(patch && headersOf(patch)["x-sloppanizer-space"]).toBe("7");
    // The spaces list itself is about the account: no project header.
    const listed = calls.find((c) => c.path.endsWith("/spaces"));
    expect(listed && headersOf(listed)["x-sloppanizer-space"]).toBeUndefined();
  });

  it("shows nothing without shared projects", async () => {
    const calls = mockApi(() => ({ body: [] }));
    renderWithApp(
      <AccountProvider account={anna}>
        <AssignedToYou />
      </AccountProvider>,
    );
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(screen.queryByRole("region", { name: "Assigned to you" })).toBeNull();
  });
});
