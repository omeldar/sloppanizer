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

/** In the popup's callback page: hands the answer to the window that asked, then closes. */
export function handBackToOpener(search: URLSearchParams): boolean {
  if (!window.opener || window.opener === window) return false;
  (window.opener as Window).postMessage(
    { type: "omeldar-reauth", query: search.toString() },
    location.origin,
  );
  window.close();
  return true;
}

/**
 * "Confirm it is you" at auth.omeldar.com in a popup (the page and its unsaved work stay): a fresh sign-in
 * there, then the API marks this session as just confirmed. Resolves false when closed or refused.
 */
export async function confirmWithOmeldar(config: OmeldarConfig): Promise<boolean> {
  const { url, pending } = await clientFor(config).signIn({ maxAge: 0, prompt: "login" });
  localStorage.setItem(REAUTH_KEY, pending.state);
  const popup = window.open(url, "omeldar-confirm", "popup,width=480,height=760");
  if (!popup)
    throw new Error("The browser blocked the sign-in window. Allow popups for this site and try again.");
  const query = await new Promise<string | null>((resolve) => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; query?: unknown } | null;
      if (
        event.origin !== location.origin ||
        data?.type !== "omeldar-reauth" ||
        typeof data.query !== "string"
      )
        return;
      done(data.query);
    };
    const closed = window.setInterval(() => popup.closed && done(null), 500);
    function done(value: string | null) {
      window.removeEventListener("message", onMessage);
      window.clearInterval(closed);
      resolve(value);
    }
    window.addEventListener("message", onMessage);
  });
  localStorage.removeItem(REAUTH_KEY);
  if (query === null) return false;
  if (new URLSearchParams(query).get("state") !== pending.state) return false;
  await apiVoid("/auth/omeldar/reauth", { method: "POST", body: { query, pending } });
  return true;
}
