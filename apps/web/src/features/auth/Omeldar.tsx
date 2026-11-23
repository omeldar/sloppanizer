import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui.tsx";
import { saveSession, TooManyAccountsError } from "../../lib/accounts.ts";
import { errorMessage } from "../../lib/api.ts";
import { afterLogin } from "../../lib/entry.ts";
import {
  callbackKind,
  finishOmeldarSignIn,
  handBackToOpener,
  type OmeldarConfig,
  startOmeldarSignIn,
} from "../../lib/omeldar.ts";
import { logoutOnServer } from "../../lib/session.ts";
import styles from "./Auth.module.css";
import type { Go } from "./LoginPage.tsx";
import { Alert, AuthShell } from "./parts.tsx";

/** "Sign in with omeldar" (or "Create an account" with `create`): goes to auth.omeldar.com. */
export function OmeldarButton({
  config,
  create = false,
  next = null,
  loginHint,
  primary = true,
}: {
  config: OmeldarConfig;
  create?: boolean;
  next?: string | null;
  loginHint?: string;
  primary?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button
        variant={primary ? "primary" : "secondary"}
        className={styles.wide}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          startOmeldarSignIn(config, { create, next, ...(loginHint ? { loginHint } : {}) }).catch(
            (problem: unknown) => {
              setError(errorMessage(problem));
              setBusy(false);
            },
          );
        }}
      >
        {create ? "Create an account with omeldar" : "Sign in with omeldar"}
      </Button>
      <Alert>{error}</Alert>
    </>
  );
}

/** /auth/callback: auth.omeldar.com sent the browser back; finish the sign-in (or the confirm popup). */
export function OmeldarCallbackPage({ search, go }: { search: URLSearchParams; go: Go }) {
  const [error, setError] = useState<string | null>(null);
  // The end of a "confirm it is you" popup, not a sign-in of this tab.
  const [confirmed] = useState(() => callbackKind(search) === "reauth");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // The code is used once: keep it out of the history.
    history.replaceState(null, "", "/auth/callback");
    if (confirmed) return handBackToOpener(search);
    const run = async () => {
      const { tokens, next } = await finishOmeldarSignIn(search);
      try {
        saveSession(tokens, new Date());
      } catch (problem) {
        await logoutOnServer(tokens.accessToken);
        throw problem instanceof TooManyAccountsError ? problem : new Error(errorMessage(problem));
      }
      go(afterLogin(tokens.account.username, next));
    };
    run().catch((problem: unknown) => setError(errorMessage(problem)));
  }, [search, go, confirmed]);

  if (confirmed) {
    // Browsers may refuse window.close() here; then this says what to do.
    return (
      <AuthShell title="Confirmed">
        <p className={styles.lede} role="status">
          You can close this window and go back to Sloppanizer.
        </p>
      </AuthShell>
    );
  }
  if (!error) {
    return (
      <AuthShell title="Signing you in">
        <p className={styles.lede} role="status">
          One moment.
        </p>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Sign-in did not work">
      <div className={styles.form}>
        <Alert>{error}</Alert>
        <div className={styles.actions}>
          <Button variant="primary" onClick={() => go("/login")}>
            Try again
          </Button>
        </div>
      </div>
    </AuthShell>
  );
}

/** The login (or sign-up) page when Sloppanizer signs in only through auth.omeldar.com. */
export function OmeldarLoginPage({
  config,
  search,
  create = false,
}: {
  config: OmeldarConfig;
  search: URLSearchParams;
  create?: boolean;
}) {
  const account = search.get("account") ?? "";
  const next = search.get("next");
  return (
    <AuthShell
      title={create ? "Create an account" : account ? `Sign in to ${account}` : "Sign in"}
      lede="Sloppanizer signs in with your omeldar account, the same one for every omeldar site."
    >
      <div className={styles.form}>
        <OmeldarButton
          config={config}
          create={create}
          next={next}
          {...(account ? { loginHint: account } : {})}
        />
        {!create && (
          <>
            <div className={styles.or}>new here?</div>
            <OmeldarButton config={config} create next={next} primary={false} />
          </>
        )}
      </div>
      <div className={styles.links}>
        <span>
          Manage your password, passkeys and second step at{" "}
          <a href={config.accountUrl}>your omeldar account</a>.
        </span>
      </div>
    </AuthShell>
  );
}
