import { normalizeOneTimeCode, Username } from "@organizer/shared";
import { type FormEvent, useState } from "react";
import { Button, Field, TextInput } from "../../components/ui.tsx";
import { resetLogin } from "../../lib/auth.ts";
import { loginFor } from "../../lib/entry.ts";
import styles from "./Auth.module.css";
import { FactorSetup } from "./FactorSetup.tsx";
import type { Go } from "./LoginPage.tsx";
import { Alert, AuthShell, RecoveryCodesBlock, Steps } from "./parts.tsx";

const RESET_STEPS = ["Reset code", "Sign-in", "Recovery codes"] as const;

type State = { step: 0 } | { step: 1; username: string } | { step: 2; username: string; codes: string[] };

/**
 * After the admin reset someone's login: the reset code (handed over outside the app) lets them set a new
 * password and authenticator, or a passkey. Their data and API tokens stayed; they sign in afterwards.
 */
export function ResetPage({ go }: { go: Go }) {
  const [state, setState] = useState<State>({ step: 0 });
  const [username, setUsername] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const next = (event: FormEvent) => {
    event.preventDefault();
    const name = Username.safeParse(username);
    if (!name.success) return setError("Enter your username.");
    if (normalizeOneTimeCode(resetCode).length < 20)
      return setError("Enter the whole reset code from the admin.");
    setError(null);
    setState({ step: 1, username: name.data });
  };

  return (
    <AuthShell
      title="Reset your login"
      lede="Use the reset code from the admin. It works once, for 24 hours."
    >
      <Steps steps={RESET_STEPS} current={state.step} />
      {state.step === 0 && (
        <form className={styles.form} onSubmit={next} noValidate>
          <Field label="Username">
            <TextInput
              className={styles.mono}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- the page's first field
              autoFocus
            />
          </Field>
          <Field label="Reset code">
            <TextInput
              className={styles.mono}
              value={resetCode}
              onChange={(event) => setResetCode(event.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              required
            />
          </Field>
          <Alert>{error}</Alert>
          <div className={styles.actions}>
            <Button type="submit" variant="primary">
              Next
            </Button>
          </div>
        </form>
      )}
      {state.step === 1 && (
        <FactorSetup
          username={state.username}
          passkeyOptionsPath="/auth/reset/passkey-options"
          passkeyOptionsBody={{ username: state.username, resetCode: resetCode.trim() }}
          submitLabel="Save the new login"
          onBack={() => setState({ step: 0 })}
          onSubmit={async (factors) => {
            const result = await resetLogin({
              username: state.username,
              resetCode: resetCode.trim(),
              ...factors,
            });
            setState({ step: 2, username: state.username, codes: result.recoveryCodes });
          }}
        />
      )}
      {state.step === 2 && (
        <div className={styles.form}>
          <RecoveryCodesBlock
            username={state.username}
            codes={state.codes}
            saved={saved}
            onSaved={setSaved}
          />
          <div className={styles.actions}>
            <Button variant="primary" disabled={!saved} onClick={() => go(loginFor(state.username))}>
              Go to sign in
            </Button>
          </div>
        </div>
      )}
    </AuthShell>
  );
}
