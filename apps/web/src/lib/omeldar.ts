import { type AuthConfig, type OidcPending, SessionTokens } from "@organizer/shared";
import { api, apiVoid } from "./api.ts";
import { browserTimeZone } from "./auth.ts";
import { createAuthClient } from "./omeldar-auth.ts";

/**
 * "Sign in with omeldar" (auth.omeldar.com) in the browser. The page builds the sign-in address and keeps
 * the pending sign-in in sessionStorage; auth sends the browser back to /auth/callback, which hands the
 * answer to the API. The API exchanges the code with the client secret: the browser never has one.
 */

export type OmeldarConfig = NonNullable<AuthConfig["omeldar"]>;

const PENDING_KEY = "sloppanizer.omeldar.pending";
/** The state of a "confirm it is you" popup, so its callback page knows to hand back to the opener. */
const REAUTH_KEY = "sloppanizer.omeldar.reauth";

const clientFor = (config: OmeldarConfig) =>
  createAuthClient({ issuer: config.issuer, clientId: config.clientId, redirectUri: config.redirectUri });

/** Goes to auth.omeldar.com to sign in (or sign up with `create`); `next` is where to land afterwards. */
export async function startOmeldarSignIn(
  config: OmeldarConfig,
  options: { create?: boolean; next?: string | null; loginHint?: string } = {},
): Promise<void> {
  const { url, pending } = await clientFor(config).signIn({
    ...(options.create ? { prompt: "create" as const } : {}),
    ...(options.loginHint ? { loginHint: options.loginHint } : {}),
  });
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ pending, next: options.next ?? null }));
  location.assign(url);
}

/** What the callback page is: the end of a sign-in, the end of a confirm popup, or something stale. */
export function callbackKind(search: URLSearchParams): "reauth" | "signin" {
  const state = search.get("state");
  try {
    if (state && localStorage.getItem(REAUTH_KEY) === state) return "reauth";
  } catch {
    // No storage: a normal sign-in.
  }
  return "signin";
}

/** The callback of a sign-in: the session for the account, and where to go. */
export async function finishOmeldarSignIn(
  search: URLSearchParams,
): Promise<{ tokens: SessionTokens; next: string | null }> {
  const raw = sessionStorage.getItem(PENDING_KEY);
  sessionStorage.removeItem(PENDING_KEY);
  const saved = raw ? (JSON.parse(raw) as { pending: OidcPending; next: string | null }) : null;
  if (!saved) throw new Error("This sign-in was started in another tab or has expired. Start again.");
  if (search.get("state") !== saved.pending.state) {
    throw new Error("The sign-in answer does not belong to this browser. Start again.");
  }
  const tokens = await api(SessionTokens, "/auth/omeldar/callback", {
    method: "POST",
    body: { query: search.toString(), pending: saved.pending, timeZone: browserTimeZone() },
  });
  return { tokens, next: saved.next };
}

/** Same-origin channel between the confirm popup and the page that opened it. */
const CHANNEL = "sloppanizer.omeldar.reauth";

/**
 * In the popup's callback page: hands the answer to the page that asked, then closes. A channel, not
 * window.opener: auth.omeldar.com's pages cut the opener (Cross-Origin-Opener-Policy).
 */
export function handBackToOpener(search: URLSearchParams): void {
  const channel = new BroadcastChannel(CHANNEL);
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel has no target origin
  channel.postMessage({ type: "omeldar-reauth", query: search.toString() });
  channel.close();
  window.close();
}

/**
 * A fresh sign-in at auth.omeldar.com in a popup (the page and its unsaved work stay). The callback's
 * query and the pending sign-in, or null when it never answers.
 */
async function signInInPopup(
  config: OmeldarConfig,
  loginHint?: string,
  create = false,
): Promise<{ query: string; pending: OidcPending } | null> {
  // `create`: auth's sign-up page (a new omeldar account), then the same fresh sign-in.
  const { url, pending } = await clientFor(config).signIn({
    maxAge: 0,
    prompt: create ? "create" : "login",
    ...(loginHint && !create ? { loginHint } : {}),
  });
  localStorage.setItem(REAUTH_KEY, pending.state);
  const popup = window.open(url, "omeldar-confirm", "popup,width=480,height=760");
  if (!popup) {
    localStorage.removeItem(REAUTH_KEY);
    throw new Error("The browser blocked the sign-in window. Allow popups for this site and try again.");
  }
  const query = await new Promise<string | null>((resolve) => {
    const channel = new BroadcastChannel(CHANNEL);
    // popup.closed says nothing once auth cut the opener: give up after 10 minutes (Cancel works anytime).
    const timeout = window.setTimeout(() => done(null), 10 * 60_000);
    function done(value: string | null) {
      channel.close();
      window.clearTimeout(timeout);
      resolve(value);
    }
    channel.addEventListener("message", (event: MessageEvent) => {
      const data = event.data as { type?: unknown; query?: unknown } | null;
      if (data?.type !== "omeldar-reauth" || typeof data.query !== "string") return;
      if (new URLSearchParams(data.query).get("state") !== pending.state) return;
      done(data.query);
    });
  });
  localStorage.removeItem(REAUTH_KEY);
  return query === null ? null : { query, pending };
}

/**
 * "Confirm it is you" at auth.omeldar.com in a popup: a fresh sign-in there, then the API marks this
 * session as just confirmed. Resolves false when it never answers. `username` (the signed-in account)
 * goes along as login_hint: when the browser is signed in at auth as someone else, auth asks for this
 * account straight away (prefilled, editable) instead of offering the other one read-only.
 */
export async function confirmWithOmeldar(config: OmeldarConfig, username?: string): Promise<boolean> {
  const answer = await signInInPopup(config, username);
  if (answer === null) return false;
  await apiVoid("/auth/omeldar/reauth", { method: "POST", body: answer });
  return true;
}

/**
 * Moves the signed-in account's sign-in to omeldar: Sloppanizer checks it is you (its own "confirm it is
 * you" when the last sign-in is older than 10 minutes), then a fresh sign-in at omeldar in a popup binds
 * that omeldar account. Resolves false when the popup never answers. With `create` the popup opens
 * auth's sign-up: for accounts auth never imported (made here after the import), which have no omeldar
 * account to sign in with (S5#18).
 */
export async function moveSignInToOmeldar(
  config: OmeldarConfig,
  username: string,
  options: { create?: boolean } = {},
): Promise<boolean> {
  await apiVoid("/auth/omeldar/link/start", { method: "POST" });
  const answer = await signInInPopup(config, username, options.create ?? false);
  if (answer === null) return false;
  await apiVoid("/auth/omeldar/link", { method: "POST", body: answer });
  return true;
}
