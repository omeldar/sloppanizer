import { type AccountStore, defaultAccount, findAccount, type StoredAccount } from "./accounts.ts";

/**
 * What app.html shows for an address. Every tab runs one account under /u/<username>, so two tabs can
 * show two accounts and their caches never mix. The auth pages run without an account.
 */
export type AuthPage = "login" | "signup" | "setup" | "reset";

export type Entry =
  | { kind: "app"; account: StoredAccount; basepath: string }
  | { kind: "auth"; page: AuthPage }
  | { kind: "redirect"; to: string };

const AUTH_PAGES: ReadonlySet<string> = new Set<AuthPage>(["login", "signup", "setup", "reset"]);

export const accountBase = (username: string) => `/u/${username}`;

/** The login page for one account, coming back to `next` (a path inside that account) afterwards. */
export function loginFor(username: string, next?: string): string {
  const query = new URLSearchParams({ account: username });
  if (next && next !== `${accountBase(username)}/`) query.set("next", next);
  return `/login?${query.toString()}`;
}

export function resolveEntry(pathname: string, search: string, store: AccountStore): Entry {
  const page = /^\/(login|signup|setup|reset)\/?$/.exec(pathname)?.[1] as AuthPage | undefined;
  if (page && AUTH_PAGES.has(page)) return { kind: "auth", page };

  const match = /^\/u\/([^/]+)(\/.*)?$/.exec(pathname);
  const username = match?.[1] ? safeDecode(match[1]) : "";
  if (username) {
    const account = findAccount(store, username);
    if (!account || account.signedOut) return { kind: "redirect", to: loginFor(username, pathname + search) };
    if (!match?.[2]) return { kind: "redirect", to: `${accountBase(username)}/${search}` };
    return { kind: "app", account, basepath: accountBase(username) };
  }

  // "/u/", "/u" or any other path of app.html: the last used account, else the login.
  const fallback = defaultAccount(store);
  return { kind: "redirect", to: fallback ? `${accountBase(fallback.username)}/` : "/login" };
}

/**
 * Where to go after signing in to `username`: `next` only when it is a path inside that account (an
 * address from the query never sends anyone to another site or account).
 */
export function afterLogin(username: string, next: string | null): string {
  const base = `${accountBase(username)}/`;
  if (next && next.startsWith(base) && !next.startsWith("//") && !next.includes("\\")) return next;
  return base;
}

function safeDecode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return "";
  }
}
