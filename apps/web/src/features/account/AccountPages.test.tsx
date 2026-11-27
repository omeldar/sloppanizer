import type { AccountProfile, AdminAccount, AdminSignup, InstanceInfo, SessionInfo } from "@organizer/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountProvider } from "../../app/account.tsx";
import type { StoredAccount } from "../../lib/accounts.ts";
import { mockApi, type RecordedCall, renderWithApp } from "../../test/render.tsx";
import { AccountPage } from "./AccountPage.tsx";
import { AdminPage } from "./AdminPage.tsx";

afterEach(() => vi.unstubAllGlobals());

const T = "2026-11-12T09:00:00.000Z";

const profile: AccountProfile = {
  id: 1,
  username: "anna",
  displayName: "Anna Private",
  firstName: "",
  lastName: "",
  dateFormat: "dmy.",
  timeFormat: "24h",
  projectView: "list",
  omeldarLinked: false,
  color: "#2EC5CE",
  role: "admin",
  timeZone: "Europe/Zurich",
  createdAt: T,
  security: {
    password: true,
    passwordChangedAt: T,
    totpSince: T,
    passkeys: 0,
    recoveryCodesLeft: 2,
    loginResetAt: null,
  },
};

const session = (id: string, current: boolean): SessionInfo => ({
  id,
  current,
  method: "password",
  device: current ? "Firefox on Windows" : "Safari on iPhone",
  createdAt: T,
  lastUsedAt: T,
  expiresAt: "2026-12-12T09:00:00.000Z",
  ip: null,
});

const OTHER = "b".repeat(32);

function accountApi(call: RecordedCall) {
  const { method, path } = call;
  if (path === "/api/v1/account" && method === "GET") return { body: profile };
  if (path === "/api/v1/account" && method === "PATCH")
    return { body: { ...profile, ...(call.body as object) } };
  if (path === "/api/v1/account/passkeys") return { body: [] };
  if (path === "/api/v1/account/sessions")
    return { body: [session("a".repeat(32), true), session(OTHER, false)] };
  if (method === "DELETE" && path === `/api/v1/account/sessions/${OTHER}`) return { status: 204 };
  return { status: 404, body: { error: { code: "not_found", message: `no ${path}` } } };
}

describe("account page", () => {
  it("shows the profile and few recovery codes, and saves only what changed", async () => {
    const calls = mockApi(accountApi);
    renderWithApp(<AccountPage />);
    expect(await screen.findByRole("heading", { name: "Account" })).toBeTruthy();
    expect(screen.getByText("2 left").getAttribute("data-tone")).toBe("warn");
    const name = screen.getByLabelText("Display name");
    await userEvent.clear(name);
    await userEvent.type(name, "Anna Home");
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ displayName: "Anna Home" }),
    );
  });

  it("signs another session out", async () => {
    const calls = mockApi(accountApi);
    renderWithApp(<AccountPage />);
    const list = await screen.findByRole("list", { name: "Sessions" });
    expect(within(list).getByText("this browser")).toBeTruthy();
    await userEvent.click(within(list).getByRole("button", { name: "Sign out" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.path.endsWith(`/sessions/${OTHER}`))).toBe(true),
    );
  });
});

const signup: AdminSignup = {
  id: 5,
  username: "petra",
  displayName: "Petra",
  note: "work account",
  createdAt: T,
  expiresAt: "2026-12-12T09:00:00.000Z",
};

const bob: AdminAccount = {
  id: 2,
  username: "bob",
  displayName: "Bob",
  role: "user",
  status: "active",
  createdAt: T,
  approvedAt: T,
  lastLoginAt: null,
  lockedUntil: null,
  activeSessions: 1,
  methods: { password: true, totp: true, passkeys: 0 },
  filesBytes: 0,
  resetPending: false,
};

const instance: InstanceInfo = {
  version: "0.1.0",
  schemaVersion: 9,
  accounts: { pending: 1, active: 2, disabled: 0 },
  dbBytes: 4096,
  filesBytes: 0,
  backups: { lastAt: null, nextAt: null, keep: 7, files: [] },
};

function adminApi(call: RecordedCall) {
  const { method, path } = call;
  if (path === "/api/v1/admin/signups") return { body: [signup] };
  if (path === "/api/v1/admin/accounts") return { body: [bob] };
  if (path === "/api/v1/admin/events") return { body: [] };
  if (path === "/api/v1/admin/instance") return { body: instance };
  if (method === "POST" && path === "/api/v1/admin/signups/5/approve") return { body: { ...bob, id: 5 } };
  if (method === "POST" && path === "/api/v1/admin/accounts/2/reset-login")
    return { body: { resetCode: "ABCD-EFGH-IJKL", expiresAt: "2026-11-13T09:00:00.000Z" } };
  return { status: 404, body: { error: { code: "not_found", message: `no ${path}` } } };
}

const stored = (role: "user" | "admin"): StoredAccount => ({
  accountId: 1,
  username: "anna",
  displayName: "Anna",
  color: "#2EC5CE",
  role,
  sessionId: "s",
  refreshToken: "r",
  addedAt: T,
  signedOut: false,
});

describe("admin page", () => {
  it("approves a sign-up and shows a reset code once", async () => {
    const calls = mockApi(adminApi);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderWithApp(
      <AccountProvider account={stored("admin")}>
        <AdminPage />
      </AccountProvider>,
    );
    const signups = await screen.findByRole("list", { name: "Sign-ups" });
    expect(within(signups).getByText(/work account/)).toBeTruthy();
    await userEvent.click(within(signups).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/admin/signups/5/approve")).toBe(true));

    const accounts = await screen.findByRole("list", { name: "Accounts" });
    await userEvent.click(within(accounts).getByRole("button", { name: "Reset login" }));
    expect(await screen.findByText("ABCD-EFGH-IJKL")).toBeTruthy();
  });

  it("is a missing page for everyone else and asks the server nothing", async () => {
    const calls = mockApi(adminApi);
    renderWithApp(
      <AccountProvider account={stored("user")}>
        <AdminPage />
      </AccountProvider>,
    );
    expect(await screen.findByText("Page not found")).toBeTruthy();
    expect(calls.filter((c) => c.path.startsWith("/api/v1/admin"))).toEqual([]);
  });
});
