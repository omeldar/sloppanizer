import { SessionTokens } from "@organizer/shared";
import {
  ACCOUNTS_KEY,
  findAccountById,
  markSignedOut,
  readAccounts,
  removeAccount,
  type StoredAccount,
  updateAccount,
  updateBrief,
} from "./accounts.ts";
import { ApiError, NETWORK_MESSAGE, responseError, safeJson } from "./apiError.ts";
import { apiUrl } from "./config.ts";

/**
 * The session of this tab: one account per page load (the /u/<username> in the address). The access
 * token lives only here, in memory; the refresh token is in the stored account entry, shared by every
 * tab of that account. Tokens never go into URLs, the query cache, logs or error messages.
 */

/** Refresh this long before the access token runs out. */
export const REFRESH_EARLY_MS = 60_000;

interface Access {
  token: string;
  expiresAt: number;
}

interface Tab {
  accountId: number;
  username: string;
  onSignedOut: () => void;
  access: Access | null;
  refreshing: Promise<string> | null;
  stopListening: () => void;
}

let tab: Tab | null = null;

/** Starts the session of this tab. `onSignedOut` runs once when the account can no longer be used. */
export function startTabSession(
  account: Pick<StoredAccount, "accountId" | "username">,
  onSignedOut: () => void,
) {
  stopTabSession();
  let notified = false;
  const current: Tab = {
    accountId: account.accountId,
    username: account.username,
    onSignedOut: () => {
      if (notified) return;
      notified = true;
      onSignedOut();
    },
    access: null,
    refreshing: null,
    stopListening: () => undefined,
  };
  // Another tab signed this account out (or removed it): this tab follows.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== ACCOUNTS_KEY) return;
    const entry = findAccountById(readAccounts(), current.accountId);
    if (!entry || entry.signedOut) current.onSignedOut();
  };
  window.addEventListener("storage", onStorage);
  current.stopListening = () => window.removeEventListener("storage", onStorage);
  tab = current;
}

export function stopTabSession(): void {
  tab?.stopListening();
  tab = null;
}

export const tabAccount = () => (tab ? { accountId: tab.accountId, username: tab.username } : null);

/** A valid access token, refreshed when it is about to expire; null on pages without an account. */
export async function accessToken(): Promise<string | null> {
  if (!tab) return null;
  if (tab.access && tab.access.expiresAt - Date.now() > REFRESH_EARLY_MS) return tab.access.token;
  return refresh(tab);
}

/**
 * The server refused `token` (401): get a new one. When another call already refreshed in the meantime,
 * its token is used instead of rotating again.
 */
export function renewAccessToken(token: string): Promise<string> {
  if (!tab) return Promise.reject(new ApiError(401, "unauthorized", "You are not signed in."));
  if (tab.access && tab.access.token !== token) return Promise.resolve(tab.access.token);
  tab.access = null;
  return refresh(tab);
}

/** The server refused a fresh token too: the session is over. */
export function sessionEnded(): void {
  if (!tab) return;
  markSignedOut(tab.accountId);
  tab.onSignedOut();
}

/** Uses the token of a sign-in right away (the setup page signs in and opens the app). */
export function adoptTokens(tokens: SessionTokens): void {
  if (tab && tab.accountId === tokens.account.id) {
    tab.access = { token: tokens.accessToken, expiresAt: Date.parse(tokens.accessExpiresAt) };
  }
}

/** One refresh per tab at a time; every caller waiting meanwhile gets the same new token. */
function refresh(current: Tab): Promise<string> {
  current.refreshing ??= refreshAccount(current.accountId)
    .then((tokens) => {
      current.access = { token: tokens.accessToken, expiresAt: Date.parse(tokens.accessExpiresAt) };
      return tokens.accessToken;
    })
    .catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 401) current.onSignedOut();
      throw error;
    })
    .finally(() => {
      current.refreshing = null;
    });
  return current.refreshing;
}

/**
 * Trades the stored refresh token of an account for new tokens and stores the rotated refresh token.
 * Runs under a Web Lock per account, so two tabs never send the same refresh token; inside the lock the
 * token is read again, because the other tab may just have rotated it. A refused refresh (401) marks
 * the account signed out; a network problem does not.
 */
export async function refreshAccount(accountId: number): Promise<SessionTokens> {
  const run = async () => {
    const entry = findAccountById(readAccounts(), accountId);
    if (!entry || entry.signedOut || !entry.refreshToken) {
      throw new ApiError(401, "unauthorized", "You were signed out. Sign in again to go on.");
    }
    let response: Response;
    try {
      response = await fetch(apiUrl("/auth/refresh"), {
        method: "POST",
        credentials: "omit",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: entry.refreshToken }),
      });
    } catch {
      throw new ApiError(0, "network", NETWORK_MESSAGE);
    }
    const json = safeJson(await response.text());
    if (response.status === 401) {
      markSignedOut(accountId);
      throw responseError(401, json);
    }
    if (!response.ok) throw responseError(response.status, json);
    const tokens = SessionTokens.safeParse(json);
    if (!tokens.success) {
      throw new ApiError(200, "bad_response", "The server sent an answer this app does not understand.");
    }
    updateAccount(accountId, { refreshToken: tokens.data.refreshToken, sessionId: tokens.data.sessionId });
    updateBrief(tokens.data.account);
    return tokens.data;
  };
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return run();
  return locks.request(`sloppanizer-refresh-${accountId}`, run);
}

/** Ends the server session with its access token; failures are ignored (the entry goes anyway). */
export async function logoutOnServer(token: string): Promise<void> {
  try {
    await fetch(apiUrl("/auth/logout"), {
      method: "POST",
      credentials: "omit",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    // Not reachable: the session runs out on the server by itself.
  }
}

/** Signs one account out: the server session ends (when reachable) and the entry leaves this browser. */
export async function signOutAccount(accountId: number): Promise<void> {
  let token: string | null = null;
  if (tab && tab.accountId === accountId) {
    token = await accessToken().catch(() => null);
    tab.stopListening();
  } else {
    token = await refreshAccount(accountId).then(
      (tokens) => tokens.accessToken,
      () => null,
    );
  }
  if (token) await logoutOnServer(token);
  removeAccount(accountId);
}
