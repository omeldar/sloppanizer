import { otpauthUri } from "@organizer/shared";
import { type InputHTMLAttributes, type ReactNode, useMemo, useState } from "react";
import { encode } from "uqr";
import { BrandMark } from "../../app/BrandMark.tsx";
import { Button, Field, TextInput } from "../../components/ui.tsx";
import { groupsOf4, recoveryCodesText } from "../../lib/auth.ts";
import { saveBlob } from "../../lib/download.ts";
import { toggleTheme, useTheme } from "../../lib/theme.ts";
import styles from "./Auth.module.css";

/** The frame of every auth page: wordmark (back to the start page), theme switch, one panel. */
export function AuthShell({
  title,
  lede,
  wide,
  children,
}: {
  title: string;
  lede?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <div className={styles.page}>
      <header className={styles.top}>
        <a className={styles.wordmark} href="/">
          <BrandMark />
          <span>Sloppanizer</span>
        </a>
        <Button variant="ghost" size="sm" onClick={toggleTheme}>
          {theme === "dark" ? "Light theme" : "Dark theme"}
        </Button>
      </header>
      <main className={styles.center}>
        <section className={styles.panel} data-wide={wide || undefined} aria-labelledby="auth-title">
          <h1 className={styles.title} id="auth-title">
            {title}
          </h1>
          {lede && <p className={styles.lede}>{lede}</p>}
          {children}
        </section>
      </main>
    </div>
  );
}

/** Where a multi-step form stands, in the status bar's segment style. */
export function Steps({ steps, current }: { steps: readonly string[]; current: number }) {
  return (
    <ol className={styles.steps} aria-label="Steps">
      {steps.map((step, index) => (
        <li
          key={step}
          data-state={index < current ? "done" : index === current ? "current" : undefined}
          aria-current={index === current ? "step" : undefined}
        >
          {index + 1} {step}
        </li>
      ))}
    </ol>
  );
}

export function Alert({ children }: { children: ReactNode }) {
  return children ? (
    <p className={styles.alert} role="alert">
      {children}
    </p>
  ) : null;
}

/** A password field with a show and hide button. */
export function PasswordInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const [shown, setShown] = useState(false);
  return (
    <span className={styles.passwordRow}>
      <TextInput {...props} type={shown ? "text" : "password"} spellCheck={false} />
      <Button
        variant="ghost"
        size="sm"
        aria-pressed={shown}
        aria-label={shown ? "Hide password" : "Show password"}
        onClick={() => setShown(!shown)}
      >
        {shown ? "Hide" : "Show"}
      </Button>
    </span>
  );
}

/** The six digit field for an authenticator code. */
export function CodeInput({
  value,
  onChange,
  label = "Authenticator code",
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  autoFocus?: boolean;
}) {
  return (
    <Field label={label}>
      <TextInput
        className={styles.mono}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9 ]*"
        maxLength={7}
        required
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the next step's only field
        autoFocus={autoFocus}
      />
    </Field>
  );
}

/** The QR code as SVG squares; no markup strings, so nothing unsanitized reaches the DOM. */
export function QrCode({ text, label }: { text: string; label: string }) {
  const path = useMemo(() => {
    const { data } = encode(text, { border: 0, ecc: "M" });
    let d = "";
    data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { d, size: data.length };
  }, [text]);
  return (
    <svg viewBox={`0 0 ${path.size} ${path.size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <path d={path.d} fill="#000000" />
    </svg>
  );
}

/** Copies text; the button says "Copied" for a moment. */
export function CopyButton({
  text,
  label,
  size = "sm",
}: {
  text: string;
  label: string;
  size?: "sm" | "md";
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Button size={size} onClick={copy}>
      {copied ? "Copied" : label}
    </Button>
  );
}

/**
 * Authenticator setup: the QR code for the app to scan, the secret to type by hand, and the first code
 * to prove it works. The secret was made in this browser and goes to the server with that code.
 */
export function TotpSetup({
  username,
  secret,
  code,
  onCode,
}: {
  username: string;
  secret: string;
  code: string;
  onCode: (code: string) => void;
}) {
  const grouped = groupsOf4(secret);
  return (
    <>
      <div className={styles.totp}>
        <div className={styles.qr}>
          <QrCode text={otpauthUri(secret, username)} label="QR code for your authenticator app" />
        </div>
        <div className={styles.secret}>
          <span>Scan the code with an authenticator app, or type this key into it:</span>
          <code className={styles.secretValue} aria-label="Authenticator key">
            {grouped}
          </code>
          <span>
            <CopyButton text={secret} label="Copy key" />
          </span>
        </div>
      </div>
      <CodeInput value={code} onChange={onCode} label="Code from the app" />
    </>
  );
}

/** Ten recovery codes to keep: copy, download, and a checkbox before going on. */
export function RecoveryCodesBlock({
  username,
  codes,
  saved,
  onSaved,
}: {
  username: string;
  codes: readonly string[];
  saved: boolean;
  onSaved: (saved: boolean) => void;
}) {
  const [shownAt] = useState(() => new Date());
  const text = recoveryCodesText(username, codes, shownAt);
  return (
    <>
      <p className={styles.info}>
        Each code signs you in once when your phone or passkey is gone. They are shown only now.
      </p>
      <ul className={styles.codes} aria-label="Recovery codes">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className={styles.codeActions}>
        <CopyButton text={codes.join("\n")} label="Copy all" />
        <Button
          size="sm"
          onClick={() =>
            saveBlob(new Blob([text], { type: "text/plain" }), `sloppanizer-recovery-${username}.txt`)
          }
        >
          Download .txt
        </Button>
      </div>
      <label className={styles.check}>
        <input type="checkbox" checked={saved} onChange={(event) => onSaved(event.target.checked)} />I saved
        these codes
      </label>
    </>
  );
}
