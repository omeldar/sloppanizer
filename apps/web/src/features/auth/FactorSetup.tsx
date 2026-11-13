import { type NewPasskey, passwordProblem, TotpCode } from "@organizer/shared";
import { type FormEvent, useState } from "react";
import { Button, Field, TextInput } from "../../components/ui.tsx";
import { errorMessage } from "../../lib/api.ts";
import { newTotpSecret, passkeyOptions } from "../../lib/auth.ts";
import { createPasskey, passkeysSupported } from "../../lib/webauthn.ts";
import styles from "./Auth.module.css";
import { Alert, PasswordInput, TotpSetup } from "./parts.tsx";

/** How a new account (or a reset one) will sign in. */
export type Factors = { password: string; totpSecret: string; totpCode: string } | { passkey: NewPasskey };

type Method = "password" | "passkey";

/**
 * The sign-in step of sign-up, setup and reset: a password plus an authenticator app, or a passkey.
 * `onSubmit` sends the whole form; a thrown error shows here and the person can fix and resend.
 */
export function FactorSetup({
  username,
  passkeyOptionsPath,
  passkeyOptionsBody,
  submitLabel,
  onBack,
  onSubmit,
}: {
  username: string;
  passkeyOptionsPath: string;
  passkeyOptionsBody: unknown;
  submitLabel: string;
  onBack?: () => void;
  onSubmit: (factors: Factors) => Promise<void>;
}) {
  const [method, setMethod] = useState<Method>("password");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [passwordDone, setPasswordDone] = useState(false);
  const [secret] = useState(() => newTotpSecret());
  const [code, setCode] = useState("");
  const [passkeyName, setPasskeyName] = useState(defaultPasskeyName());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canPasskey = passkeysSupported();

  const send = async (factors: Factors) => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(factors);
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = (event: FormEvent) => {
    event.preventDefault();
    const problem = passwordProblem(password, username);
    if (problem) return setError(problem);
    if (password !== repeat) return setError("The two passwords are not the same.");
    setError(null);
    setPasswordDone(true);
  };

  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    const parsed = TotpCode.safeParse(code);
    if (!parsed.success) return setError("Enter the 6 digit code from your authenticator app.");
    void send({ password, totpSecret: secret, totpCode: parsed.data });
  };

  const submitPasskey = async (event: FormEvent) => {
    event.preventDefault();
    const name = passkeyName.trim();
    if (!name) return setError("Give the passkey a name, for example the device it is on.");
    setBusy(true);
    setError(null);
    try {
      const challenge = await passkeyOptions(passkeyOptionsPath, passkeyOptionsBody);
      const response = await createPasskey(challenge.options);
      setBusy(false);
      if (!response) return setError("No passkey was made. Try again when you are ready.");
      await send({ passkey: { challengeId: challenge.challengeId, response, name } as NewPasskey });
    } catch (problem) {
      setBusy(false);
      setError(errorMessage(problem));
    }
  };

  if (method === "password" && passwordDone) {
    return (
      <form className={styles.form} onSubmit={submitCode} noValidate>
        <TotpSetup username={username} secret={secret} code={code} onCode={setCode} />
        <Alert>{error}</Alert>
        <div className={styles.actions}>
          <Button onClick={() => (setPasswordDone(false), setError(null))}>Back</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Checking" : submitLabel}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form
      className={styles.form}
      onSubmit={method === "password" ? submitPassword : (event) => void submitPasskey(event)}
      noValidate
    >
      <fieldset className={styles.methods}>
        <legend>How do you want to sign in?</legend>
        <MethodOption
          value="password"
          current={method}
          onPick={setMethod}
          title="Password and authenticator code"
          note="A password plus a 6 digit code from an app on your phone."
        />
        {canPasskey && (
          <MethodOption
            value="passkey"
            current={method}
            onPick={setMethod}
            title="Passkey"
            note="This device or your password manager signs you in. No password to remember."
          />
        )}
      </fieldset>

      {method === "password" ? (
        <>
          <Field label="Password" hint="At least 12 characters, without your username.">
            <PasswordInput
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              required
            />
          </Field>
          <Field label="Password again">
            <PasswordInput
              value={repeat}
              onChange={(event) => setRepeat(event.target.value)}
              autoComplete="new-password"
              required
            />
          </Field>
        </>
      ) : (
        <Field label="Passkey name" hint="So you can tell your passkeys apart later.">
          <TextInput
            value={passkeyName}
            onChange={(event) => setPasskeyName(event.target.value)}
            maxLength={60}
          />
        </Field>
      )}

      <Alert>{error}</Alert>
      <div className={styles.actions}>
        {onBack && <Button onClick={onBack}>Back</Button>}
        <Button type="submit" variant="primary" disabled={busy}>
          {method === "password" ? "Next" : busy ? "Waiting for the passkey" : "Create passkey"}
        </Button>
      </div>
    </form>
  );
}

function MethodOption({
  value,
  current,
  onPick,
  title,
  note,
}: {
  value: Method;
  current: Method;
  onPick: (method: Method) => void;
  title: string;
  note: string;
}) {
  return (
    <label className={styles.method} data-on={current === value || undefined}>
      <input
        type="radio"
        name="method"
        value={value}
        checked={current === value}
        onChange={() => onPick(value)}
      />
      <span>{title}</span>
      <span className={styles.methodNote}>{note}</span>
    </label>
  );
}

/** "Passkey on Windows" and the like, from the platform the browser reports. */
function defaultPasskeyName(): string {
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform ||
    "";
  if (/win/i.test(platform)) return "Passkey on Windows";
  if (/mac/i.test(platform)) return "Passkey on Mac";
  if (/android/i.test(platform)) return "Passkey on Android";
  if (/iphone|ipad|ios/i.test(platform)) return "Passkey on iPhone";
  if (/linux/i.test(platform)) return "Passkey on Linux";
  return "My passkey";
}
