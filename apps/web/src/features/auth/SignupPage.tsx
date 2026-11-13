import { type AuthConfig, SIGNUP_NOTE_MAX } from "@organizer/shared";
import { type FormEvent, useState } from "react";
import { Button, Field } from "../../components/ui.tsx";
import { browserTimeZone, signup } from "../../lib/auth.ts";
import { loginFor } from "../../lib/entry.ts";
import { type AccountDraft, AccountFields, checkAccount } from "./AccountFields.tsx";
import styles from "./Auth.module.css";
import { FactorSetup } from "./FactorSetup.tsx";
import { Alert, AuthShell, RecoveryCodesBlock, Steps } from "./parts.tsx";

export const SIGNUP_STEPS = ["Account", "Sign-in", "Recovery codes", "Approval"] as const;

type State =
  | { step: 0 }
  | { step: 1; displayName: string; username: string }
  | { step: 2; username: string; codes: string[] }
  | { step: 3; username: string };

/**
 * Sign-up in four steps. The account is made in one request at the end of step 2 (with a password and
 * authenticator, or a passkey), so a half-done sign-up leaves nothing on the server. It waits for the
 * admin's approval; there is no mail, the person simply signs in later.
 */
export function SignupPage({ config }: { config: AuthConfig | null }) {
  const [state, setState] = useState<State>({ step: 0 });
  const [draft, setDraft] = useState<AccountDraft>({ displayName: "", username: "" });
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (config && !config.signupsOpen && state.step === 0) {
    return (
      <AuthShell title="Sign up">
        <p className={`${styles.info} ${styles.form}`}>Sign-ups are paused right now. Try again later.</p>
        <div className={styles.links}>
          <span>
            Already have an account? <a href="/login">Sign in</a>
          </span>
        </div>
      </AuthShell>
    );
  }

  const next = (event: FormEvent) => {
    event.preventDefault();
    const checked = checkAccount(draft);
    if ("problem" in checked) return setError(checked.problem);
    if (note.trim().length > SIGNUP_NOTE_MAX) {
      return setError(`Keep the note at ${SIGNUP_NOTE_MAX} characters or fewer.`);
    }
    setError(null);
    setState({ step: 1, ...checked });
  };

  return (
    <AuthShell
      title="Sign up"
      lede="Sloppanizer accounts are approved by hand. Your data stays in your account only."
    >
      <Steps steps={SIGNUP_STEPS} current={state.step} />
      {state.step === 0 && (
        <form className={styles.form} onSubmit={next} noValidate>
          <AccountFields draft={draft} onChange={setDraft} />
          <Field
            label="Note to the admin (optional)"
            hint="Who you are, so the admin knows the sign-up is yours."
          >
            <textarea
              className={styles.note}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={SIGNUP_NOTE_MAX}
              rows={3}
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
          passkeyOptionsPath="/auth/signup/passkey-options"
          passkeyOptionsBody={{ username: state.username, displayName: state.displayName }}
          submitLabel="Sign up"
          onBack={() => setState({ step: 0 })}
          onSubmit={async (factors) => {
            const result = await signup({
              username: state.username,
              displayName: state.displayName,
              ...(note.trim() ? { note: note.trim() } : {}),
              timeZone: browserTimeZone(),
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
            <Button
              variant="primary"
              disabled={!saved}
              onClick={() => setState({ step: 3, username: state.username })}
            >
              Continue
            </Button>
          </div>
        </div>
      )}
      {state.step === 3 && (
        <>
          <div className={styles.waiting} role="status">
            <div>
              <p className={styles.waitingTitle}>{state.username}: waiting for approval</p>
              <p>Your sign-up waits for approval. Sign in once it is approved.</p>
            </div>
          </div>
          <div className={styles.links}>
            <span>
              <a href={loginFor(state.username)}>Go to sign in</a>
            </span>
            <span>
              <a href="/">Back to the start page</a>
            </span>
          </div>
        </>
      )}
    </AuthShell>
  );
}
