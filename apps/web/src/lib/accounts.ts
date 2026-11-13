import { AccountColor, AccountRole, type AccountBrief, type SessionTokens } from "@organizer/shared";
import { z } from "zod";

/**
 * The accounts signed in in this browser (localStorage). Each entry holds the refresh token of its
 * session; access tokens stay in the memory of each tab (lib/session.ts). Unknown versions or broken
 * JSON count as "no accounts": a bad entry never stops the app from starting.
 */

export const ACCOUNTS_KEY = "sloppanizer.accounts.v1";
export const MAX_ACCOUNTS = 5;

const StoredAccount = z.object({
  accountId: z.number().int().positive(),
  username: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,31}$/),
  displayName: z.string(),
  color: AccountColor.catch("#8B95A5"),
  role: AccountRole.catch("user"),
  sessionId: z.string(),
  refreshToken: z.string(),
  addedAt: z.string(),
  signedOut: z.boolean(),
});
export type StoredAccount = z.infer<typeof StoredAccount>;

const AccountStore = z.object({
  version: z.literal(1),
  lastUsed: z.string().nullable(),
  accounts: z.array(z.unknown()),
});

export interface AccountStore {
  version: 1;
  lastUsed: string | null;
  accounts: StoredAccount[];
}

const empty = (): AccountStore => ({ version: 1, lastUsed: null, accounts: [] });

/** The stored accounts; broken entries are left out, everything broken reads as empty. */
export function readAccounts(storage: Storage = localStorage): AccountStore {
  let raw: string | null;
  try {
    raw = storage.getItem(ACCOUNTS_KEY);
  } catch {
    return empty();
  }
  if (!raw) return empty();
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return empty();
  }
  const store = AccountStore.safeParse(json);
  if (!store.success) return empty();
  const accounts = store.data.accounts.flatMap((entry) => {
    const account = StoredAccount.safeParse(entry);
    return account.success ? [account.data] : [];
  });
  return { version: 1, lastUsed: store.data.lastUsed, accounts: accounts.slice(0, MAX_ACCOUNTS) };
}

export function writeAccounts(store: AccountStore, storage: Storage = localStorage): void {
  storage.setItem(ACCOUNTS_KEY, JSON.stringify(store));
}

export const findAccount = (store: AccountStore, username: string) =>
  store.accounts.find((account) => account.username === username);

export const findAccountById = (store: AccountStore, accountId: number) =>
  store.accounts.find((account) => account.accountId === accountId);

/** The account to open when the address names none: the last used one, else the first signed-in one. */
export function defaultAccount(store: AccountStore): StoredAccount | undefined {
  const last = store.lastUsed ? findAccount(store, store.lastUsed) : undefined;
  if (last && !last.signedOut) return last;
  return store.accounts.find((account) => !account.signedOut);
}

export class TooManyAccountsError extends Error {
  constructor() {
    super(
      `This browser keeps at most ${MAX_ACCOUNTS} accounts. Sign out of one in the account menu, then try again.`,
    );
    this.name = "TooManyAccountsError";
  }
}

/**
 * Stores a new session (after a sign-in) and makes it the last used account. The same account replaces
 * its old entry. When the browser is full, signed-out entries make room (oldest first); with five
 * signed-in accounts it throws TooManyAccountsError and changes nothing.
 */
export function saveSession(
  tokens: SessionTokens,
  now: Date,
  storage: Storage = localStorage,
): StoredAccount {
  const store = readAccounts(storage);
  const entry: StoredAccount = {
    accountId: tokens.account.id,
    username: tokens.account.username,
    displayName: tokens.account.displayName,
    color: tokens.account.color,
    role: tokens.account.role,
    sessionId: tokens.sessionId,
    refreshToken: tokens.refreshToken,
    addedAt: findAccountById(store, tokens.account.id)?.addedAt ?? now.toISOString(),
    signedOut: false,
  };
  let others = store.accounts.filter(
    (account) => account.accountId !== entry.accountId && account.username !== entry.username,
  );
  while (others.length >= MAX_ACCOUNTS) {
    const oldestSignedOut = others
      .filter((account) => account.signedOut)
      .toSorted((a, b) => a.addedAt.localeCompare(b.addedAt))[0];
    if (!oldestSignedOut) throw new TooManyAccountsError();
    others = others.filter((account) => account !== oldestSignedOut);
  }
  writeAccounts({ version: 1, lastUsed: entry.username, accounts: [...others, entry] }, storage);
  return entry;
}

/** Changes one entry (rotated refresh token, new name or color); a missing entry stays missing. */
export function updateAccount(
  accountId: number,
  change: Partial<Omit<StoredAccount, "accountId" | "username">>,
  storage: Storage = localStorage,
): StoredAccount | undefined {
  const store = readAccounts(storage);
  const current = findAccountById(store, accountId);
  if (!current) return undefined;
  const next = { ...current, ...change };
  writeAccounts({ ...store, accounts: store.accounts.map((a) => (a === current ? next : a)) }, storage);
  return next;
}

/** The profile fields the server sent (display name, color, role) into the stored entry. */
export const updateBrief = (brief: AccountBrief, storage: Storage = localStorage) =>
  updateAccount(brief.id, { displayName: brief.displayName, color: brief.color, role: brief.role }, storage);

/** Keeps the entry (so the switcher can offer to sign in again) but forgets its refresh token. */
export const markSignedOut = (accountId: number, storage: Storage = localStorage) =>
  updateAccount(accountId, { signedOut: true, refreshToken: "" }, storage);

export function removeAccount(accountId: number, storage: Storage = localStorage): void {
  const store = readAccounts(storage);
  const removed = findAccountById(store, accountId);
  const accounts = store.accounts.filter((account) => account.accountId !== accountId);
  const lastUsed = store.lastUsed === removed?.username ? (accounts[0]?.username ?? null) : store.lastUsed;
  writeAccounts({ version: 1, lastUsed, accounts }, storage);
}

export function setLastUsed(username: string, storage: Storage = localStorage): void {
  const store = readAccounts(storage);
  if (store.lastUsed === username || !findAccount(store, username)) return;
  writeAccounts({ ...store, lastUsed: username }, storage);
}
