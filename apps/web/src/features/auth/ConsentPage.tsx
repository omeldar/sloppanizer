import { type FormEvent, useEffect, useState } from "react";
import { Button } from "../../components/ui.tsx";
import { readAccounts } from "../../lib/accounts.ts";
import { apiUrl } from "../../lib/config.ts";
import { refreshAccount } from "../../lib/session.ts";
import styles from "./Auth.module.css";
import type { Go } from "./LoginPage.tsx";
import { Alert, AuthShell } from "./parts.tsx";

interface Described {
  clientName: string;
  redirectHost: string;
  scope: "read" | "write";
  denyUrl: string;
}

type Load =
  | { state: "loading" }
  | { state: "ready"; request: Described }
  | { state: "failed"; message: string; denyUrl?: string };

const PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "scope",
  "resource",
] as const;

/** The login page for one account (or any), coming back to this consent page. */
const loginHref = (here: string, username?: string) => {
  const query = new URLSearchParams({ next: here });
  if (username) query.set("account", username);
  return `/login?${query.toString()}`;
};

/**
 * OAuth consent: an MCP client (Claude, say) asks to use one of the accounts signed in here. The user
 * picks the account and read or read-and-change; approving needs a recent sign-in, else the login
 * page comes first and brings the user back here.
 */
export function ConsentPage({ search, go }: { search: URLSearchParams; go: Go }) {
  const here = `/oauth/authorize?${search.toString()}`;
  const accounts = readAccounts().accounts.filter((a) => !a.signedOut);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [accountId, setAccountId] = useState<number | null>(accounts[0]?.accountId ?? null);
  const [grant, setGrant] = useState<"read" | "write">("write");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Connect an app: Sloppanizer";
    if (accounts.length === 0) go(loginHref(here));
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- once, on load
  }, []);

  useEffect(() => {
    let alive = true;
    const query = new URLSearchParams();
    for (const key of PARAMS) {
      const value = search.get(key);
      if (value !== null) query.set(key, value);
    }
    const run = async () => {
      try {
        const res = await fetch(apiUrl(`/auth/oauth/request?${query.toString()}`), {
          credentials: "omit",
          headers: { accept: "application/json" },
        });
        const json = (await res.json()) as Described & { error?: { message: string }; denyUrl?: string };
        if (!alive) return;
        if (res.ok) {
          setLoad({ state: "ready", request: json });
          if (json.scope === "read") setGrant("read");
        } else {
          setLoad({
            state: "failed",
            message: json.error?.message ?? "This request cannot be used.",
            ...(json.denyUrl ? { denyUrl: json.denyUrl } : {}),
          });
        }
      } catch {
        if (alive) setLoad({ state: "failed", message: "Sloppanizer is not reachable. Try again." });
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [search]);

  if (load.state === "loading" || accounts.length === 0) {
    return (
      <AuthShell title="Connect an app">
        <p className={styles.lede}>Loading the request.</p>
      </AuthShell>
    );
  }
  if (load.state === "failed") {
    return (
      <AuthShell title="This app cannot connect">
        <Alert>{load.message}</Alert>
        {load.denyUrl && (
          <div className={styles.links}>
            <a href={load.denyUrl}>Back to the app</a>
          </div>
        )}
      </AuthShell>
    );
  }

  const { request } = load;
  const chosen = accounts.find((a) => a.accountId === accountId);

  const approve = async (event: FormEvent) => {
    event.preventDefault();
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const tokens = await refreshAccount(chosen.accountId);
      const body: Record<string, string> = { grant };
      for (const key of PARAMS) {
        const value = search.get(key);
        if (value !== null) body[key] = value;
      }
      const res = await fetch(apiUrl("/auth/oauth/approve"), {
        method: "POST",
        credentials: "omit",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${tokens.accessToken}`,
        },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { redirectTo?: string; error?: { code: string; message: string } };
      if (res.ok && json.redirectTo) {
        go(json.redirectTo);
        return;
      }
      if (json.error?.code === "reauth_required" || res.status === 401) {
        // A recent sign-in is needed to connect an app: sign in, then come back here.
        go(loginHref(here, chosen.username));
        return;
      }
      setError(json.error?.message ?? "Could not connect the app. Try again.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not connect the app. Try again.");
    }
    setBusy(false);
  };

  return (
    <AuthShell
      title={`Connect ${request.clientName}`}
      lede={
        <>
          <strong>{request.clientName}</strong> wants to use your Sloppanizer todos, notes and people. You go
          back to <span className={styles.mono}>{request.redirectHost}</span> afterwards.
        </>
      }
    >
      <form className={styles.form} onSubmit={(event) => void approve(event)}>
        <fieldset className={styles.methods}>
          <legend>Account</legend>
          {accounts.map((account) => (
            <label
              key={account.accountId}
              className={styles.method}
              data-on={account.accountId === accountId || undefined}
            >
              <input
                type="radio"
                name="account"
                checked={account.accountId === accountId}
                onChange={() => setAccountId(account.accountId)}
              />
              <span>{account.displayName || account.username}</span>
              <span className={styles.methodNote}>{account.username}</span>
            </label>
          ))}
          <a className={styles.methodNote} href={`${loginHref(here)}&add=1`}>
            Use another account
          </a>
        </fieldset>
        <fieldset className={styles.methods}>
          <legend>Access</legend>
          {request.scope === "write" && (
            <label className={styles.method} data-on={grant === "write" || undefined}>
              <input
                type="radio"
                name="grant"
                checked={grant === "write"}
                onChange={() => setGrant("write")}
              />
              <span>Read and change</span>
              <span className={styles.methodNote}>Create and edit todos, notes, people and comments.</span>
            </label>
          )}
          <label className={styles.method} data-on={grant === "read" || undefined}>
            <input type="radio" name="grant" checked={grant === "read"} onChange={() => setGrant("read")} />
            <span>Read only</span>
            <span className={styles.methodNote}>Look things up, change nothing.</span>
          </label>
        </fieldset>
        <p className={styles.methodNote}>
          It shows as the token {request.clientName} under Settings, API tokens. Revoke it there to
          disconnect.
        </p>
        <Alert>{error}</Alert>
        <div className={styles.actions}>
          <Button onClick={() => go(request.denyUrl)} disabled={busy}>
            Deny
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !chosen}>
            Allow
          </Button>
        </div>
      </form>
    </AuthShell>
  );
}
