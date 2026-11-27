import type { Notification, NotificationList } from "@organizer/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountProvider } from "../../app/account.tsx";
import { setSpace } from "../../lib/api.ts";
import type { StoredAccount } from "../../lib/accounts.ts";
import { headersOf, makeTodo, mockApi, renderWithApp } from "../../test/render.tsx";
import { ActionNeededBanner } from "../todos/ActionNeeded.tsx";
import { NotificationBell } from "./NotificationBell.tsx";

const T = "2026-11-11T09:00:00.000Z";
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

const note = (id: number, more: Partial<Notification>): Notification => ({
  id,
  kind: "commented",
  actor: "bobo",
  excerpt: "",
  todo: { id: 3, title: "Book van", status: "open", ref: "S7#3" },
  space: { id: 7, name: "Home move" },
  createdAt: T,
  readAt: null,
  ...more,
});

const list: NotificationList = {
  unreadCount: 2,
  items: [
    note(2, { kind: "mentioned", excerpt: "@anna can you check the price?" }),
    note(1, {
      kind: "action_needed",
      actor: "assistant",
      excerpt: "Approve the DNS change",
      todo: { id: 12, title: "Renew certs", status: "open", ref: "#12" },
      space: null,
    }),
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  setSpace(null);
});

describe("notification bell (S5#6)", () => {
  it("shows the unread count and the newest, and opening one marks it read", async () => {
    // Inside a shared project's tab the bell still asks for your own notifications.
    setSpace(7);
    const calls = mockApi(({ method }) =>
      method === "POST" ? { body: { ...list, unreadCount: 1 } } : { body: list },
    );
    renderWithApp(
      <AccountProvider account={anna}>
        <NotificationBell />
      </AccountProvider>,
    );
    const bell = await screen.findByRole("button", { name: "Notifications, 2 unread" });
    const asked = calls.find((c) => c.path.startsWith("/api/v1/notifications"));
    expect(asked && headersOf(asked)["x-sloppanizer-space"]).toBeUndefined();
    await userEvent.click(bell);
    const panels = await screen.findAllByRole("region", { name: "Notifications" });
    const panel = panels.at(-1) as HTMLElement;
    // The popover takes the panel's width, so long text stays inside its border (S5#12).
    expect(panel.parentElement?.className).toMatch(/popover/);
    const links = within(panel).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/u/anna/shared/7/todos/3", "/todos/12"]);
    expect(links[0]?.textContent).toContain("bobo mentioned you");
    expect(links[1]?.textContent).toContain("assistant needs you to act");
    expect(links[1]?.textContent).toContain("Approve the DNS change");
    await userEvent.click(links[1] as HTMLElement);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")).toMatchObject({
        path: "/api/v1/notifications/read",
        body: { ids: [1] },
      }),
    );
  });

  it("marks all read", async () => {
    const calls = mockApi(({ method }) =>
      method === "POST" ? { body: { ...list, unreadCount: 0 } } : { body: list },
    );
    renderWithApp(
      <AccountProvider account={anna}>
        <NotificationBell />
      </AccountProvider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Notifications, 2 unread" }));
    await userEvent.click(await screen.findByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ all: true }));
    expect(await screen.findByRole("button", { name: "Notifications" })).toBeTruthy();
  });
});

describe("action needed on a todo (S5#6)", () => {
  it("shows the reason and who set it, and removes the marker", async () => {
    const todo = makeTodo({
      id: 12,
      actionNeeded: { reason: "Approve the DNS change", by: "assistant", at: T },
    });
    const calls = mockApi(() => ({ body: { ...todo, actionNeeded: null } }));
    renderWithApp(<ActionNeededBanner todo={todo} />);
    const banner = await screen.findByRole("note", { name: "Action needed" });
    expect(banner.textContent).toContain("Approve the DNS change");
    expect(banner.textContent).toContain("Set by assistant");
    await userEvent.click(within(banner).getByRole("button", { name: "Done, remove" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")).toEqual({
        method: "PATCH",
        path: "/api/v1/todos/12",
        body: { actionNeeded: null },
      }),
    );
  });
});
