import { normalizeOneTimeCode, type SessionTokens } from "@organizer/shared";
import { type FormEvent, useState } from "react";
import { Button, Field, TextInput } from "../../components/ui.tsx";
import { saveSession } from "../../lib/accounts.ts";
import { browserTimeZone, setup } from "../../lib/auth.ts";
import { accountBase } from "../../lib/entry.ts";
import { type AccountDraft, AccountFields, checkAccount } from "./AccountFields.tsx";
import styles from "./Auth.module.css";
import { FactorSetup } from "./FactorSetup.tsx";
import type { Go } from "./LoginPage.tsx";
import { Alert, AuthShell, RecoveryCodesBlock, Steps } from "./parts.tsx";

const SETUP_STEPS = ["Setup code", "Admin account", "Sign-in", "Recovery codes"] as const;

type State =
  | { step: 0 | 1 }
  | { step: 2; displayName: string; username: string }
  | { step: 3; username: string; codes: string[]; session: SessionTokens };

/**
 * The first admin account of a new instance, with the setup code from the server log. Ends signed in.
 * Once an admin exists the server answers 404 and AuthApp shows the not-found view instead.
 */
export function SetupPage({ go }: { go: Go }) {
  const [state, setState] = useState<State>({ step: 0 });
  const [setupCode, setSetupCode] = useState("");
  const [draft, setDraft] = useState<AccountDraft>({ displayName: "", username: "" });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const codeNext = (event: FormEvent) => {
    event.preventDefault();
    if (normalizeOneTimeCode(setupCode).length < 20)
      return setError("Enter the whole setup code from the server log.");
    setError(null);
    setState({ step: 1 });
  };

  const accountNext = (event: FormEvent) => {
    event.preventDefault();
    const checked = checkAccount(draft);
    if ("problem" in checked) return setError(checked.problem);
    setError(null);
    setState({ step: 2, ...checked });
  };

  return (
    <AuthShell title="Set up Sloppanizer" lede="Make the admin account. The admin approves every sign-up.">
      <Steps steps={SETUP_STEPS} current={state.step} />
      {state.step === 0 && (
        <form className={styles.form} onSubmit={codeNext} noValidate>
          <Field
            label="Setup code"
            hint="The server prints it in its log at start: XXXX-XXXX-XXXX-XXXX-XXXX."
          >
            <TextInput
              className={styles.mono}
              value={setupCode}
              onChange={(event) => setSetupCode(event.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              required
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- the page's only field
              autoFocus
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
        <form className={styles.form} onSubmit={accountNext} noValidate>
          <AccountFields draft={draft} onChange={setDraft} />
          <Alert>{error}</Alert>
          <div className={styles.actions}>
            <Button onClick={() => setState({ step: 0 })}>Back</Button>
            <Button type="submit" variant="primary">
              Next
            </Button>
          </div>
        </form>
      )}
      {state.step === 2 && (
        <FactorSetup
          username={state.username}
          passkeyOptionsPath="/auth/setup/passkey-options"
          passkeyOptionsBody={{
            setupCode: setupCode.trim(),
            username: state.username,
            displayName: state.displayName,
          }}
          submitLabel="Make the admin account"
          onBack={() => setState({ step: 1 })}
          onSubmit={async (factors) => {
            const result = await setup({
              setupCode: setupCode.trim(),
              username: state.username,
              displayName: state.displayName,
              timeZone: browserTimeZone(),
              ...factors,
            });
            setState({
              step: 3,
              username: state.username,
              codes: result.recoveryCodes,
              session: result.session,
            });
          }}
        />
      )}
      {state.step === 3 && (
        <div className={styles.form}>
          <RecoveryCodesBlock
            username={state.username}
            codes={state.codes}
            saved={saved}
            onSaved={setSaved}
          />
          <div className={styles.actions}>
            <Button
              variant="primary"
              disabled={!saved}
              onClick={() => {
                saveSession(state.session, new Date());
                go(`${accountBase(state.username)}/`);
              }}
            >
              Open Sloppanizer
            </Button>
          </div>
        </div>
      )}
    </AuthShell>
  );
}
