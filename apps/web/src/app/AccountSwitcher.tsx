import { useNavigate } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { Menu, type MenuItem } from "../components/Menu.tsx";
import { MAX_ACCOUNTS, type StoredAccount } from "../lib/accounts.ts";
import { accountBase, loginFor } from "../lib/entry.ts";
import { currentSpace } from "../lib/api.ts";
import { signOutAccount } from "../lib/session.ts";
import { useAccounts } from "./account.tsx";
import styles from "./Layout.module.css";

/** Opens another account in this tab (each account lives under its own /u/<username>). */
export function switchTo(account: StoredAccount): void {
  window.location.assign(
    account.signedOut ? loginFor(account.username) : `${accountBase(account.username)}/`,
  );
}

/**
 * Gmail-like switcher at the bottom of the sidebar: the accounts signed in in this browser, adding one,
 * the account page, signing out.
 */
export function AccountSwitcher() {
  const accounts = useAccounts();
  const navigate = useNavigate();
  if (!accounts) return null;
  const { current, all } = accounts;
  const others = all.filter((a) => a.accountId !== current.accountId);

  const items: MenuItem[] = [
    ...others.map((account) => ({
      label: `Switch to ${account.displayName} (${account.username})${account.signedOut ? ", signed out" : ""}`,
      run: () => switchTo(account),
    })),
    ...(all.length < MAX_ACCOUNTS
      ? [{ label: "Add another account", run: () => window.location.assign("/login?add=1") }]
      : []),
    {
      label: "Account settings",
      // Inside a shared project the account page lives in your own tab.
      run: () =>
        currentSpace() === null
          ? void navigate({ to: "/account" })
          : window.location.assign(`${accountBase(current.username)}/account`),
    },
    {
      label: `Sign out ${current.username}`,
      danger: true,
      run: () => {
        void signOutAccount(current.accountId).finally(() => window.location.assign("/"));
      },
    },
  ];

  return (
    <div className={styles.switcher}>
      <Menu
        label="Accounts"
        items={items}
        trigger={
          <button type="button" className={styles.switcherButton} aria-label="Switch account">
            <span className={styles.swatch} style={{ "--swatch": current.color } as CSSProperties} />
            <span className={styles.switcherName}>
              <span>{current.displayName}</span>
              <span className={styles.switcherUser}>{current.username}</span>
            </span>
          </button>
        }
      />
    </div>
  );
}
