import type { AuthConfig } from "@organizer/shared";
import { useEffect, useState } from "react";
import { authConfig } from "../../lib/auth.ts";
import type { AuthPage } from "../../lib/entry.ts";
import styles from "./Auth.module.css";
import { LoginPage, type Go } from "./LoginPage.tsx";
import { OmeldarCallbackPage, OmeldarLoginPage } from "./Omeldar.tsx";
import { AuthShell } from "./parts.tsx";
import { ConsentPage } from "./ConsentPage.tsx";
import { ResetPage } from "./ResetPage.tsx";
import { SetupPage } from "./SetupPage.tsx";
import { SignupPage } from "./SignupPage.tsx";

const TITLES: Record<AuthPage, string> = {
  login: "Sign in",
  signup: "Sign up",
  setup: "Set up",
  reset: "Reset your login",
  oauth: "Connect an app",
  callback: "Signing in",
};

/** The pages without an account: sign in, sign up, first setup and login reset. */
export function AuthApp({ page, search, go }: { page: AuthPage; search: URLSearchParams; go: Go }) {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [configFailed, setConfigFailed] = useState(false);
  const needsConfig = page === "signup" || page === "setup" || page === "login";

  useEffect(() => {
    document.title = `${TITLES[page]}: Sloppanizer`;
  }, [page]);

  useEffect(() => {
    if (!needsConfig) return;
    let alive = true;
    authConfig().then(
      (value) => alive && setConfig(value),
      () => alive && setConfigFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [needsConfig]);

  if (page === "callback") return <OmeldarCallbackPage search={search} go={go} />;
  if (page === "login") {
    // Waits for the config: with omeldar only, the own login form must not start (its passkey prompt).
    if (!config && !configFailed) return null;
    if (config?.omeldar && (config.mode === "oidc" || ownLoginEnded(config))) {
      return (
        <OmeldarLoginPage
          config={config.omeldar}
          search={search}
          endedOn={config.mode === "both" ? (config.localLoginEnds?.on ?? null) : null}
        />
      );
    }
    return (
      <LoginPage
        search={search}
        go={go}
        omeldar={config?.omeldar ?? null}
        localLoginEndsOn={config?.localLoginEnds?.on ?? null}
      />
    );
  }
  if (page === "oauth") return <ConsentPage search={search} go={go} />;
  if (page === "reset") return <ResetPage go={go} />;
  if (page === "signup") {
    if (config?.omeldar && (config.mode === "oidc" || ownLoginEnded(config)))
      return <OmeldarLoginPage config={config.omeldar} search={search} create />;
    return <SignupPage config={config} />;
  }
  // Setup only while the instance has no admin; afterwards the page does not exist.
  if (config?.setupNeeded) return <SetupPage go={go} />;
  if (config || configFailed) return <NotFound />;
  return null;
}

/** Whether SLOPPANIZER_LOCAL_LOGIN_UNTIL has passed (the server refuses the own login from then on). */
const ownLoginEnded = (config: AuthConfig): boolean =>
  config.localLoginEnds != null && Date.parse(config.localLoginEnds.at) <= Date.now();

export function NotFound() {
  return (
    <AuthShell title="This page does not exist.">
      <p className={styles.lede}>
        The address may have a typo. <a href="/">Go to the start page</a> or <a href="/login">sign in</a>.
      </p>
    </AuthShell>
  );
}
