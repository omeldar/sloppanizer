import { AccountColor, PROJECT_COLORS, passwordProblem, type Passkey, TotpCode } from "@organizer/shared";
import { type CSSProperties, type FormEvent, useState } from "react";
import { Button, ErrorState, Field, Loading, PageHeader, TextInput } from "../../components/ui.tsx";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import {
  addPasskey,
  deleteOwnAccount,
  newRecoveryCodes,
  useAccountProfile,
  useChangePassword,
  usePasskeys,
  useRemovePasskey,
  useRenamePasskey,
  useReplaceTotp,
  useRevokeOtherSessions,
  useRevokeSession,
  useSessions,
  useUpdateProfile,
} from "../../lib/accountQueries.ts";
import { removeAccount } from "../../lib/accounts.ts";
import { errorMessage } from "../../lib/api.ts";
import { browserTimeZone, newTotpSecret } from "../../lib/auth.ts";
import { absoluteTime, relativeTime } from "../../lib/format.ts";
import { stopTabSession } from "../../lib/session.ts";
import { passkeysSupported } from "../../lib/webauthn.ts";
import { PasswordInput, RecoveryCodesBlock, TotpSetup } from "../auth/parts.tsx";
import styles from "./Account.module.css";

/** The signed-in account: profile, how it signs in, its sessions, and deleting it. */
export function AccountPage() {
  const profile = useAccountProfile();
  if (profile.isPending) return <Loading />;
  if (profile.isError) return <ErrorState error={profile.error} onRetry={() => void profile.refetch()} />;
  const data = profile.data;
  return (
    <div className={styles.page}>
      <PageHeader title="Account" />
      <ProfileSection
        key={`${data.displayName}|${data.firstName}|${data.lastName}|${data.color}|${data.timeZone}`}
        displayName={data.displayName}
        firstName={data.firstName}
        lastName={data.lastName}
        color={data.color}
        timeZone={data.timeZone}
        username={data.username}
      />
      <PasswordSection username={data.username} hasPassword={data.security.password} />
      {data.security.password && <AuthenticatorSection username={data.username} />}
      <PasskeysSection />
      <RecoveryCodesSection username={data.username} left={data.security.recoveryCodesLeft} />
      <SessionsSection />
      <DeleteSection accountId={data.id} username={data.username} />
    </div>
  );
}

function ProfileSection(props: {
  displayName: string;
  firstName: string;
  lastName: string;
  color: string;
  timeZone: string;
  username: string;
}) {
  const update = useUpdateProfile();
  const toast = useToast();
  const [displayName, setDisplayName] = useState(props.displayName);
  const [firstName, setFirstName] = useState(props.firstName);
  const [lastName, setLastName] = useState(props.lastName);
  const [color, setColor] = useState(props.color);
  const [timeZone, setTimeZone] = useState(props.timeZone);
  const zones = timeZones(props.timeZone);
  const changed =
    displayName.trim() !== props.displayName ||
    firstName.trim() !== props.firstName ||
    lastName.trim() !== props.lastName ||
    color !== props.color ||
    timeZone !== props.timeZone;

  const save = (event: FormEvent) => {
    event.preventDefault();
    update.mutate(
      {
        ...(displayName.trim() === props.displayName ? {} : { displayName: displayName.trim() }),
        ...(firstName.trim() === props.firstName ? {} : { firstName: firstName.trim() }),
        ...(lastName.trim() === props.lastName ? {} : { lastName: lastName.trim() }),
        ...(color === props.color ? {} : { color: AccountColor.parse(color) }),
        ...(timeZone === props.timeZone ? {} : { timeZone }),
      },
      { onSuccess: () => toast.show({ message: "Profile saved." }) },
    );
  };

  return (
    <section className={styles.section} aria-labelledby="profile-heading">
      <h2 className={styles.heading} id="profile-heading">
        Profile
      </h2>
      <p className={styles.text}>
        Signed in as <span className={styles.mono}>{props.username}</span>. The name and color tell your
        accounts apart in the switcher.
      </p>
      <form className={styles.form} onSubmit={save}>
        <Field label="Display name">
          <TextInput value={displayName} maxLength={64} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <div className={styles.nameRow}>
          <Field label="First name">
            <TextInput value={firstName} maxLength={60} onChange={(e) => setFirstName(e.target.value)} />
          </Field>
          <Field label="Last name">
            <TextInput value={lastName} maxLength={60} onChange={(e) => setLastName(e.target.value)} />
          </Field>
        </div>
        <p className={styles.text}>
          Optional. Shared projects and your bug reports show this name; without one, your username.
        </p>
        <div className={styles.swatches} role="radiogroup" aria-label="Color">
          {PROJECT_COLORS.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={color === value}
              aria-label={value}
              className={styles.swatch}
              data-on={color === value || undefined}
              style={{ "--swatch": value } as CSSProperties}
              onClick={() => setColor(value)}
            />
          ))}
        </div>
        <Field label="Time zone" hint="For today, due dates and overdue.">
          <select className={styles.select} value={timeZone} onChange={(e) => setTimeZone(e.target.value)}>
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </Field>
        <div className={styles.formRow}>
          <Button type="submit" variant="primary" disabled={!changed || update.isPending}>
            Save profile
          </Button>
        </div>
        {update.isError && <p className={styles.error}>{errorMessage(update.error)}</p>}
      </form>
    </section>
  );
}

function timeZones(current: string): string[] {
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return [...new Set([current, browserTimeZone(), "UTC", ...all])].toSorted();
}

function PasswordSection({ username, hasPassword }: { username: string; hasPassword: boolean }) {
  const change = useChangePassword();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [secret] = useState(() => newTotpSecret());
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const weak = passwordProblem(password, username);
    if (weak) return setProblem(weak);
    if (password !== repeat) return setProblem("The two passwords differ.");
    if (!hasPassword && !TotpCode.safeParse(code).success) return setProblem("Enter the 6-digit code.");
    setProblem(null);
    change.mutate(
      { newPassword: password, ...(hasPassword ? {} : { totpSecret: secret, totpCode: code }) },
      {
        onSuccess: () => {
          toast.show({ message: "Password saved. Other sessions were signed out." });
          setOpen(false);
          setPassword("");
          setRepeat("");
        },
      },
    );
  };

  return (
    <section className={styles.section} aria-labelledby="password-heading">
      <h2 className={styles.heading} id="password-heading">
        Password
      </h2>
      <p className={styles.text}>
        {hasPassword
          ? "You sign in with your password and a code from your authenticator app."
          : "This account signs in with passkeys only. A password always comes with an authenticator app."}
      </p>
      {!open ? (
        <Button onClick={() => setOpen(true)}>{hasPassword ? "Change password" : "Add a password"}</Button>
      ) : (
        <form className={styles.form} onSubmit={submit}>
          <Field label="New password" hint="At least 12 characters; a few words work well.">
            <PasswordInput
              value={password}
              autoComplete="new-password"
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field label="Repeat it">
            <PasswordInput
              value={repeat}
              autoComplete="new-password"
              onChange={(e) => setRepeat(e.target.value)}
            />
          </Field>
          {!hasPassword && <TotpSetup username={username} secret={secret} code={code} onCode={setCode} />}
          <div className={styles.formRow}>
            <Button type="submit" variant="primary" disabled={change.isPending}>
              Save password
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
          {(problem ?? change.error) && (
            <p className={styles.error}>{problem ?? errorMessage(change.error)}</p>
          )}
        </form>
      )}
    </section>
  );
}

function AuthenticatorSection({ username }: { username: string }) {
  const replace = useReplaceTotp();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState(() => newTotpSecret());
  const [code, setCode] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    replace.mutate(
      { totpSecret: secret, totpCode: code },
      {
        onSuccess: () => {
          toast.show({ message: "New authenticator saved. The old one no longer works." });
          setOpen(false);
          setSecret(newTotpSecret());
          setCode("");
        },
      },
    );
  };

  return (
    <section className={styles.section} aria-labelledby="totp-heading">
      <h2 className={styles.heading} id="totp-heading">
        Authenticator app
      </h2>
      <p className={styles.text}>
        Moving to a new phone? Set the app up again here; the old one stops working.
      </p>
      {!open ? (
        <Button onClick={() => setOpen(true)}>Replace authenticator</Button>
      ) : (
        <form className={styles.form} onSubmit={submit}>
          <TotpSetup username={username} secret={secret} code={code} onCode={setCode} />
          <div className={styles.formRow}>
            <Button type="submit" variant="primary" disabled={replace.isPending || code.length !== 6}>
              Save authenticator
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
          {replace.isError && <p className={styles.error}>{errorMessage(replace.error)}</p>}
        </form>
      )}
    </section>
  );
}

function PasskeysSection() {
  const passkeys = usePasskeys();
  const rename = useRenamePasskey();
  const remove = useRemovePasskey();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = passkeysSupported();

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await addPasskey(defaultPasskeyName());
      await passkeys.refetch();
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setBusy(false);
    }
  };

  const onRename = (key: Passkey) => {
    const name = window.prompt("Name of this passkey", key.name)?.trim();
    if (name && name !== key.name) rename.mutate({ id: key.id, name });
  };

  return (
    <section className={styles.section} aria-labelledby="passkeys-heading">
      <h2 className={styles.heading} id="passkeys-heading">
        Passkeys
      </h2>
      <p className={styles.text}>
        Sign in with your fingerprint, face or device PIN instead of password and code.
      </p>
      {passkeys.data && passkeys.data.length > 0 && (
        <ul className={styles.list} aria-label="Passkeys">
          {passkeys.data.map((key) => (
            <li key={key.id} className={styles.item}>
              <div className={styles.itemMain}>
                <span className={styles.itemTitle}>{key.name}</span>
                <span className={styles.itemMeta}>
                  Added {absoluteTime(key.createdAt)}
                  {key.lastUsedAt ? `, last used ${relativeTime(key.lastUsedAt)}` : ", not used yet"}
                  {key.backedUp ? ", synced" : ""}
                </span>
              </div>
              <div className={styles.actions}>
                <Button size="sm" onClick={() => onRename(key)}>
                  Rename
                </Button>
                <Button size="sm" variant="danger" onClick={() => remove.mutate(key.id)}>
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.formRow} style={{ marginTop: 10 }}>
        <Button onClick={() => void add()} disabled={!supported || busy}>
          Add a passkey
        </Button>
        {!supported && <span className={styles.empty}>This browser has no passkey support.</span>}
      </div>
      {(error ?? remove.error ?? rename.error) && (
        <p className={styles.error}>{error ?? errorMessage(remove.error ?? rename.error)}</p>
      )}
    </section>
  );
}

function defaultPasskeyName(): string {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua)
    ? "Windows"
    : /iPhone|iPad/.test(ua)
      ? "iPhone"
      : /Mac/.test(ua)
        ? "Mac"
        : /Android/.test(ua)
          ? "Android"
          : "Linux";
  return `Passkey on ${os}`;
}

function RecoveryCodesSection({ username, left }: { username: string; left: number }) {
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const make = async () => {
    setError(null);
    try {
      setCodes((await newRecoveryCodes()).recoveryCodes);
      setSaved(false);
    } catch (problem) {
      setError(errorMessage(problem));
    }
  };
  return (
    <section className={styles.section} aria-labelledby="recovery-heading">
      <div className={styles.headingRow}>
        <h2 className={styles.heading} id="recovery-heading">
          Recovery codes
        </h2>
        <span className={styles.badge} data-tone={left <= 3 ? "warn" : "good"}>
          {left} left
        </span>
      </div>
      <p className={styles.text}>For when your phone or passkey is gone. New codes replace all old ones.</p>
      {codes ? (
        <div className={styles.form}>
          <RecoveryCodesBlock username={username} codes={codes} saved={saved} onSaved={setSaved} />
          <div className={styles.formRow}>
            <Button variant="primary" disabled={!saved} onClick={() => setCodes(null)}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <Button onClick={() => void make()}>Make new recovery codes</Button>
      )}
      {error && <p className={styles.error}>{error}</p>}
    </section>
  );
}

function SessionsSection() {
  const sessions = useSessions();
  const revoke = useRevokeSession();
  const revokeOthers = useRevokeOtherSessions();
  const others = (sessions.data ?? []).filter((s) => !s.current).length;
  return (
    <section className={styles.section} aria-labelledby="sessions-heading">
      <h2 className={styles.heading} id="sessions-heading">
        Sessions
      </h2>
      <p className={styles.text}>Browsers signed in to this account.</p>
      {sessions.isPending && <Loading />}
      {sessions.data && (
        <ul className={styles.list} aria-label="Sessions">
          {sessions.data.map((session) => (
            <li key={session.id} className={styles.item}>
              <div className={styles.itemMain}>
                <span className={styles.itemTitle}>
                  {session.device}{" "}
                  {session.current && (
                    <span className={styles.badge} data-tone="good">
                      this browser
                    </span>
                  )}
                </span>
                <span className={styles.itemMeta}>
                  Signed in {absoluteTime(session.createdAt)} with {session.method}, last active{" "}
                  {relativeTime(session.lastUsedAt)}
                  {session.ip ? `, ${session.ip}` : ""}
                </span>
              </div>
              {!session.current && (
                <div className={styles.actions}>
                  <Button size="sm" onClick={() => revoke.mutate(session.id)}>
                    Sign out
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {others > 0 && (
        <div className={styles.formRow} style={{ marginTop: 10 }}>
          <Button onClick={() => revokeOthers.mutate()} disabled={revokeOthers.isPending}>
            Sign out all other sessions
          </Button>
        </div>
      )}
    </section>
  );
}

function DeleteSection({ accountId, username }: { accountId: number; username: string }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await deleteOwnAccount(typed.trim().toLowerCase());
      stopTabSession();
      removeAccount(accountId);
      window.location.assign("/");
    } catch (problem) {
      setError(errorMessage(problem));
      setBusy(false);
    }
  };
  return (
    <section className={styles.section} aria-labelledby="delete-heading">
      <h2 className={styles.heading} id="delete-heading">
        Delete account
      </h2>
      <p className={styles.text}>
        Deletes every todo, note, person and file of this account for good. Download an export first.
      </p>
      {!open ? (
        <Button variant="danger" onClick={() => setOpen(true)}>
          Delete this account
        </Button>
      ) : (
        <form className={styles.form} onSubmit={(e) => void submit(e)}>
          <Field label={`Type ${username} to confirm`}>
            <TextInput value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
          </Field>
          <div className={styles.formRow}>
            <Button type="submit" variant="danger" disabled={busy || typed.trim().toLowerCase() !== username}>
              Delete for good
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
          {error && <p className={styles.error}>{error}</p>}
        </form>
      )}
    </section>
  );
}
