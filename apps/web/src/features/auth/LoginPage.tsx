import { type Login, RecoveryCode, type SessionTokens, TotpCode } from "@organizer/shared";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button, Field, TextInput } from "../../components/ui.tsx";
import { saveSession, TooManyAccountsError } from "../../lib/accounts.ts";
import { errorMessage } from "../../lib/api.ts";
import { login, loginWithPasskey } from "../../lib/auth.ts";
import { accountBase, afterLogin } from "../../lib/entry.ts";
import { formatDate } from "../../lib/format.ts";
import { logoutOnServer } from "../../lib/session.ts";
import { conditionalMediationAvailable, passkeysSupported } from "../../lib/webauthn.ts";
import styles from "./Auth.module.css";
import { OmeldarButton } from "./Omeldar.tsx";
import { Alert, AuthShell, CodeInput, PasswordInput } from "./parts.tsx";
import type { OmeldarConfig } from "../../lib/omeldar.ts";

/** Where the browser goes after a sign-in; a full page load, so the new account starts clean. */
export type Go = (to: string) => void;

export function LoginPage({
  search,
  go,
  omeldar = null,
  localLoginEndsOn = null,
}: {
  search: URLSearchParams;
  go: Go;
  /** Set while "Sign in with omeldar" is offered next to the own login (SLOPPANIZER_AUTH=both). */
  omeldar?: OmeldarConfig | null;
  /** The day the own login stops (SLOPPANIZER_LOCAL_LOGIN_UNTIL), or null. */
  localLoginEndsOn?: string | null;
}) {
  const account = search.get("account") ?? "";
  const next = search.get("next");
  const adding = search.get("add") === "1";
  const [username, setUsername] = useState(account);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [usedRecovery, setUsedRecovery] = useState<{ tokens: SessionTokens; to: string } | null>(null);
  const conditional = useRef<AbortController | null>(null);

  const finish = async (tokens: SessionTokens) => {
    try {
      saveSession(tokens, new Date());
    } catch (problem) {
      // The browser is full: this new session must not stay open on the server either.
      await logoutOnServer(tokens.accessToken);
      throw problem instanceof TooManyAccountsError ? problem : new Error(errorMessage(problem));
    }
    const to = afterLogin(tokens.account.username, next);
    if (tokens.recoveryCodesLeft !== null) setUsedRecovery({ tokens, to });
    else go(to);
  };

  // Browsers that offer passkeys in the username autofill get them there, without a button press.
  useEffect(() => {
    let stopped = false;
    const offer = async () => {
      if (!(await conditionalMediationAvailable()) || stopped) return;
      const controller = new AbortController();
      conditional.current = controller;
      try {
        const tokens = await loginWithPasskey({ conditional: true, signal: controller.signal });
        if (tokens && !stopped) await finish(tokens);
      } catch (problem: unknown) {
        if (!controller.signal.aborted && !stopped) setError(errorMessage(problem));
      }
    };
    void offer();
    return () => {
      stopped = true;
      conditional.current?.abort();
    };
    // Runs once per page; finish only reads the address, which does not change here.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const name = username.trim().toLowerCase();
    if (!name) return setError("Enter your username.");
    let input: Login;
    if (recovery) {
      const parsed = RecoveryCode.safeParse(code);
      if (!parsed.success) return setError("Enter a recovery code like abcd-efgh-ijkl-mnop.");
      input = password
        ? { username: name, password, recoveryCode: parsed.data }
        : { username: name, recoveryCode: parsed.data };
    } else {
      if (!password) return setError("Enter your password.");
      const parsed = TotpCode.safeParse(code);
      if (!parsed.success) return setError("Enter the 6 digit code from your authenticator app.");
      input = { username: name, password, code: parsed.data };
    }
    setBusy(true);
    setError(null);
    try {
      await finish(await login(input));
    } catch (problem) {
      setError(errorMessage(problem));
      setBusy(false);
    }
  };

  const withPasskey = async () => {
    conditional.current?.abort();
    setBusy(true);
    setError(null);
    try {
      const tokens = await loginWithPasskey();
      if (tokens) await finish(tokens);
      else setBusy(false);
    } catch (problem) {
      setError(errorMessage(problem));
      setBusy(false);
    }
  };

  if (usedRecovery) {
    const left = usedRecovery.tokens.recoveryCodesLeft ?? 0;
    const security = `${accountBase(usedRecovery.tokens.account.username)}/settings/account`;
    return (
      <AuthShell title={`Signed in to ${usedRecovery.tokens.account.username}`}>
        <div className={styles.form}>
          <p className={styles.info} role="status">
            You used a recovery code; {left} {left === 1 ? "is" : "are"} left. If your phone or passkey is
            gone, set up your authenticator again in <a href={security}>Security</a>.
          </p>
          <div className={styles.actions}>
            <Button onClick={() => go(security)}>Open Security</Button>
            <Button variant="primary" onClick={() => go(usedRecovery.to)}>
              Continue
            </Button>
          </div>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={account ? `Sign in to ${account}` : "Sign in"}
      lede={adding ? "Add another account to this browser. The others stay signed in." : undefined}
    >
      {omeldar && (
        <div className={styles.form}>
          <OmeldarButton config={omeldar} next={next} {...(account ? { loginHint: account } : {})} />
          <div className={styles.or}>or with your Sloppanizer password</div>
          {localLoginEndsOn && (
            <p className={styles.lede}>
              Sign-in with your Sloppanizer password ends on {formatDate(localLoginEndsOn)}. Move to omeldar
              before then: sign in, then Account.
            </p>
          )}
        </div>
      )}
      <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        <Field label="Username">
          <TextInput
            className={styles.mono}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username webauthn"
            autoCapitalize="none"
            spellCheck={false}
            required
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the page's first field
            autoFocus={!account}
          />
        </Field>
        <Field
          label="Password"
          hint={recovery ? "Leave it empty if your account signs in with a passkey only." : undefined}
        >
          <PasswordInput
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required={!recovery}
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the username is already filled in
            autoFocus={Boolean(account)}
          />
        </Field>
        {recovery ? (
          <Field label="Recovery code">
            <TextInput
              className={styles.mono}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="abcd-efgh-ijkl-mnop"
              required
            />
          </Field>
        ) : (
          <CodeInput value={code} onChange={setCode} />
        )}
        <button
          type="button"
          className={styles.linkButton}
          onClick={() => {
            setRecovery(!recovery);
            setCode("");
          }}
        >
          {recovery ? "Use the authenticator code instead" : "Use a recovery code instead"}
        </button>
        <Alert>{error}</Alert>
        <Button type="submit" variant="primary" className={styles.wide} disabled={busy}>
          Sign in
        </Button>
        {passkeysSupported() && (
          <>
            <div className={styles.or}>or</div>
            <Button className={styles.wide} onClick={() => void withPasskey()} disabled={busy}>
              Sign in with a passkey
            </Button>
          </>
        )}
      </form>
      <div className={styles.links}>
        <span>
          No account yet? <a href="/signup">Sign up</a>
        </span>
        <span>
          Lost access? Ask the admin to reset your login, then open <a href="/reset">/reset</a>.
        </span>
      </div>
    </AuthShell>
  );
}
