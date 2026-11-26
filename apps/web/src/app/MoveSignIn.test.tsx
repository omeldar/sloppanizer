import type { AccountProfile, AuthConfig } from "@organizer/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi, type RecordedCall, renderWithApp } from "../test/render.tsx";
import { MoveSignInBanner, moveSignInState, SNOOZE_MS } from "./MoveSignIn.tsx";

const T = "2026-11-12T09:00:00.000Z";
const LATER_KEY = "sloppanizer.moveSignIn.later.1";

const profile: AccountProfile = {
  id: 1,
  username: "anna",
  displayName: "Anna",
  firstName: "",
  lastName: "",
  dateFormat: "dmy.",
  timeFormat: "24h",
  projectView: "list",
  omeldarLinked: false,
  color: "#2EC5CE",
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
};

const omeldar = {
  issuer: "https://auth.example.test",
  clientId: "sloppanizer",
  redirectUri: "http://localhost:3000/auth/callback",
  accountUrl: "https://auth.example.test/account",
};

const config = (extra: Partial<AuthConfig> = {}): AuthConfig => ({
  signupsOpen: true,
  setupNeeded: false,
  rpId: "localhost",
  mode: "both",
  omeldar,
  localLoginEnds: null,
  ...extra,
});

/** Ends in 20 days, far from "soon". */
const in20Days = () => {
  const at = new Date(Date.now() + 20 * 86_400_000);
  return { on: at.toISOString().slice(0, 10), at: at.toISOString() };
};

function server(
  auth: AuthConfig,
  account: AccountProfile = profile,
  extra: (call: RecordedCall) => { status?: number; body?: unknown } | null = () => null,
) {
  return mockApi((call) => {
    const own = extra(call);
    if (own) return own;
    if (call.path === "/api/v1/auth/config") return { body: auth };
    if (call.path === "/api/v1/account") return { body: account };
    return { status: 404, body: { error: { code: "not_found", message: `no ${call.path}` } } };
  });
}

const BANNER = /Move your sign-in|Sign-in with your Sloppanizer password/;

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("move your sign-in to omeldar", () => {
  it("asks accounts that still use their Sloppanizer password, with the day it ends; Later hides it for a day", async () => {
    const ends = in20Days();
    server(config({ localLoginEnds: ends }));
    renderWithApp(<MoveSignInBanner />);
    const [y, m, d] = ends.on.split("-");
    const banner = await screen.findByText(
      `Sign-in with your Sloppanizer password ends on ${d}.${m}.${y}. Move your sign-in to your omeldar account before then. Your data stays.`,
    );
    expect(banner.closest("[role=status]")?.getAttribute("data-tone")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByText(BANNER)).toBeNull();
    const until = Number(localStorage.getItem(LATER_KEY));
    expect(until - Date.now()).toBeGreaterThan(SNOOZE_MS - 60_000);
  });

  it("asks again once the day has passed, and without an end day it asks without one", async () => {
    localStorage.setItem(LATER_KEY, String(Date.now() - 1));
    server(config());
    renderWithApp(<MoveSignInBanner />);
    expect(
      await screen.findByText(
        "Move your sign-in to your omeldar account, the one sign-in for every omeldar site. Your data stays.",
      ),
    ).toBeTruthy();
  });

  it("stays, in amber and without Later, once the own login has ended", async () => {
    localStorage.setItem(LATER_KEY, String(Date.now() + SNOOZE_MS));
    server(config({ localLoginEnds: { on: "2026-11-01", at: "2026-10-31T23:00:00.000Z" } }));
    renderWithApp(<MoveSignInBanner />);
    const text = await screen.findByText(/Sign-in with your Sloppanizer password ended on 01\.11\.2026\./);
    expect(text.closest("[role=status]")?.getAttribute("data-tone")).toBe("amber");
    expect(screen.queryByRole("button", { name: "Later" })).toBeNull();
  });

  it("says nothing to accounts that moved, or when omeldar is not offered next to the own login", () => {
    const linked = { ...profile, omeldarLinked: true };
    expect(moveSignInState(config(), linked, Date.now())).toBeNull();
    expect(moveSignInState(config({ mode: "local", omeldar: null }), profile, Date.now())).toBeNull();
    expect(moveSignInState(config({ mode: "oidc" }), profile, Date.now())).toBeNull();
    // An older server without the field: no end day.
    const { localLoginEnds: _, ...old } = config();
    expect(moveSignInState(old, profile, Date.now())).toMatchObject({ endsOn: null, ended: false });
  });

  it("explains the move, checks with the server first and shows why it cannot go on", async () => {
    const open = vi.fn<typeof window.open>(() => null);
    vi.stubGlobal("open", open);
    let started = 0;
    server(config(), profile, (call) => {
      if (call.path !== "/api/v1/auth/omeldar/link/start") return null;
      started++;
      return started === 1
        ? {
            status: 409,
            body: { error: { code: "conflict", message: "Your sign-in already moved to omeldar." } },
          }
        : { status: 204 };
    });
    renderWithApp(<MoveSignInBanner />);
    await userEvent.click(await screen.findByRole("button", { name: "Move my sign-in" }));
    const dialog = await screen.findByRole("dialog", { name: "Move your sign-in to omeldar" });
    expect(within(dialog).getByText(/todos, notes, API tokens and connected apps stay/)).toBeTruthy();

    await userEvent.click(within(dialog).getByRole("button", { name: "Continue at omeldar" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "Your sign-in already moved to omeldar.",
    );
    expect(open).not.toHaveBeenCalled();

    // Next time the check passes and the popup is next: a blocked one says what to do.
    await userEvent.click(within(dialog).getByRole("button", { name: "Continue at omeldar" }));
    await waitFor(() => expect(open).toHaveBeenCalledOnce());
    const url = new URL(String(open.mock.calls[0]?.[0]));
    expect(url.origin).toBe("https://auth.example.test");
    expect(url.searchParams.get("login_hint")).toBe("anna");
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/blocked the sign-in window/);
  });
});
