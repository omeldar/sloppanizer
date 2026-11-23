import { type Reauth, RecoveryCode, TotpCode } from "@organizer/shared";
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DialogActions, DialogBody } from "../components/Dialog.tsx";
import { Button, Field, TextInput } from "../components/ui.tsx";
import { CodeInput, PasswordInput } from "../features/auth/parts.tsx";
import { reauth, reauthWithPasskey, useAccountProfile } from "../lib/accountQueries.ts";
import { errorMessage, setReauthHandler } from "../lib/api.ts";
import { authConfig } from "../lib/auth.ts";
import { confirmWithOmeldar } from "../lib/omeldar.ts";
import { passkeysSupported } from "../lib/webauthn.ts";
import { useQuery } from "@tanstack/react-query";
import styles from "../features/auth/Auth.module.css";

const ignore = (): void => undefined;

/**
 * "Confirm it is you": sensitive actions (new password, passkeys, tokens, restore, admin changes) need a
 * sign-in from the last 10 minutes. When the server asks for one, this dialog opens; once confirmed, the
 * waiting call is sent again (lib/api.ts). Several calls at once share one dialog.
 */
export function ReauthProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const waiting = useRef<{ promise: Promise<boolean>; resolve: (ok: boolean) => void } | null>(null);

  const ask = useCallback(() => {
    if (!waiting.current) {
      let resolve: (ok: boolean) => void = ignore;
      const promise = new Promise<boolean>((done) => (resolve = done));
      waiting.current = { promise, resolve };
      setOpen(true);
    }
    return waiting.current.promise;
  }, []);

  useEffect(() => {
    setReauthHandler(ask);
    return () => setReauthHandler(null);
  }, [ask]);

  const close = (ok: boolean) => {
    waiting.current?.resolve(ok);
    waiting.current = null;
    setOpen(false);
  };

  return (
    <>
      {children}
      <Dialog
        open={open}
        onOpenChange={(next) => !next && close(false)}
        title="Confirm it is you"
        description="This change needs a fresh sign-in. It counts for 10 minutes."
        width={420}
      >
        {open && <ReauthForm onDone={() => close(true)} onCancel={() => close(false)} />}
      </Dialog>
    </>
  );
}

type Mode = "code" | "recovery";

function ReauthForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const profile = useAccountProfile();
  const config = useQuery({ queryKey: ["auth-config"], queryFn: authConfig, staleTime: Infinity });
  const omeldar = config.data?.omeldar ?? null;
  const viaOmeldar = omeldar !== null && (profile.data?.omeldarLinked ?? false);
  const omeldarOnly = config.data?.mode === "oidc";
  const hasPassword = profile.data?.security.password ?? true;
  const hasPasskeys = (profile.data?.security.passkeys ?? 0) > 0 && passkeysSupported();
  const [mode, setMode] = useState<Mode>("code");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<boolean | void>) => {
    setBusy(true);
    setError(null);
    try {
      if ((await action()) !== false) onDone();
      else setBusy(false);
    } catch (problem) {
      setError(errorMessage(problem));
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    let input: Reauth;
    if (mode === "recovery") {
      const parsed = RecoveryCode.safeParse(code);
      if (!parsed.success) return setError("Enter a recovery code like abcd-efgh-ijkl-mnop.");
      input = password ? { password, recoveryCode: parsed.data } : { recoveryCode: parsed.data };
    } else {
      const parsed = TotpCode.safeParse(code);
      if (!password) return setError("Enter your password.");
      if (!parsed.success) return setError("Enter the 6 digit code from your authenticator app.");
      input = { password, code: parsed.data };
    }
    void run(() => reauth(input));
  };

  const recoveryOnly = !hasPassword;
  const current: Mode = recoveryOnly ? "recovery" : mode;

  if (omeldarOnly) {
    return (
      <DialogBody>
        {omeldar && (
          <Button
            variant="primary"
            className={styles.wide}
            disabled={busy}
            onClick={() => void run(() => confirmWithOmeldar(omeldar))}
          >
            Confirm at omeldar
          </Button>
        )}
        {error && (
          <p className={styles.alert} role="alert">
            {error}
          </p>
        )}
        <DialogActions>
          <Button onClick={onCancel}>Cancel</Button>
        </DialogActions>
      </DialogBody>
    );
  }

  return (
    <DialogBody onSubmit={submit}>
      {viaOmeldar && omeldar && (
        <>
          <Button
            variant="primary"
            className={styles.wide}
            disabled={busy}
            onClick={() => void run(() => confirmWithOmeldar(omeldar))}
          >
            Confirm at omeldar
          </Button>
          <div className={styles.or}>or</div>
        </>
      )}
      {hasPasskeys && (
        <>
          <Button
            variant="primary"
            className={styles.wide}
            disabled={busy}
            onClick={() => void run(reauthWithPasskey)}
          >
            Use a passkey
          </Button>
          <div className={styles.or}>or</div>
        </>
      )}
      {hasPassword && (
        <Field label="Password">
          <PasswordInput
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog's first field
            autoFocus={!hasPasskeys}
          />
        </Field>
      )}
      {current === "code" ? (
        <CodeInput value={code} onChange={setCode} />
      ) : (
        <Field label="Recovery code">
          <TextInput
            className={styles.mono}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="abcd-efgh-ijkl-mnop"
          />
        </Field>
      )}
      {!recoveryOnly && (
        <button
          type="button"
          className={styles.linkButton}
          onClick={() => {
            setMode(mode === "code" ? "recovery" : "code");
            setCode("");
          }}
        >
          {mode === "code" ? "Use a recovery code instead" : "Use the authenticator code instead"}
        </button>
      )}
      {error && (
        <p className={styles.alert} role="alert">
          {error}
        </p>
      )}
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant={hasPasskeys ? "secondary" : "primary"} disabled={busy}>
          Confirm
        </Button>
      </DialogActions>
    </DialogBody>
  );
}
