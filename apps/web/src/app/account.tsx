import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { ACCOUNTS_KEY, findAccountById, readAccounts, type StoredAccount } from "../lib/accounts.ts";

/**
 * The account of this tab (from /u/<username>) and the other accounts stored in the browser, kept up
 * to date when another tab signs in, out or renames one.
 */
interface AccountState {
  current: StoredAccount;
  all: StoredAccount[];
}

const AccountContext = createContext<AccountState | null>(null);

export function AccountProvider({ account, children }: { account: StoredAccount; children: ReactNode }) {
  const [state, setState] = useState<AccountState>(() => ({
    current: account,
    all: readAccounts().accounts,
  }));
  useEffect(() => {
    const reload = (event?: StorageEvent) => {
      if (event && event.key !== null && event.key !== ACCOUNTS_KEY) return;
      const store = readAccounts();
      setState((previous) => ({
        current: findAccountById(store, previous.current.accountId) ?? previous.current,
        all: store.accounts,
      }));
    };
    const onChanged = () => reload();
    window.addEventListener("storage", reload);
    window.addEventListener(ACCOUNTS_CHANGED, onChanged);
    return () => {
      window.removeEventListener("storage", reload);
      window.removeEventListener(ACCOUNTS_CHANGED, onChanged);
    };
  }, []);
  return <AccountContext.Provider value={state}>{children}</AccountContext.Provider>;
}

/** Fired in this tab after it changed the stored accounts (the storage event only reaches other tabs). */
export const ACCOUNTS_CHANGED = "sloppanizer-accounts-changed";
export const announceAccountsChanged = () => window.dispatchEvent(new Event(ACCOUNTS_CHANGED));

/** Null outside an account page (tests of single components, the auth pages). */
export const useAccounts = () => useContext(AccountContext);
export const useCurrentAccount = () => useContext(AccountContext)?.current ?? null;
