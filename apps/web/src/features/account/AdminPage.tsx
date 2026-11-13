import type { AdminAccount, AdminEvent, ResetCodeResult } from "@organizer/shared";
import { type FormEvent, useState } from "react";
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  PageHeader,
  TextInput,
} from "../../components/ui.tsx";
import { CopyButton } from "../auth/parts.tsx";
import {
  type AccountAction,
  useAccountAction,
  useAdminAccounts,
  useAdminEvents,
  useApproveSignup,
  useBackupNow,
  useDeleteAccount,
  useInstance,
  useRejectSignup,
  useResetLogin,
  useSignups,
} from "../../lib/adminQueries.ts";
import { errorMessage } from "../../lib/api.ts";
import { absoluteTime, formatBytes, relativeTime } from "../../lib/format.ts";
import { useCurrentAccount } from "../../app/account.tsx";
import styles from "./Account.module.css";

/** The admin's view: sign-ups to approve, accounts (metadata only, never contents), backups, the log. */
export function AdminPage() {
  const me = useCurrentAccount();
  if (me && me.role !== "admin") {
    return (
      <>
        <PageHeader title="Page not found" />
        <EmptyState>This address does not exist.</EmptyState>
      </>
    );
  }
  return (
    <div className={styles.page}>
      <PageHeader title="Admin" />
      <SignupsSection />
      <AccountsSection selfId={me?.accountId ?? 0} />
      <InstanceSection />
      <LogSection />
    </div>
  );
}

function SignupsSection() {
  const signups = useSignups();
  const approve = useApproveSignup();
  const reject = useRejectSignup();
  const error = approve.error ?? reject.error;
  return (
    <section className={styles.section} aria-labelledby="signups-heading">
      <h2 className={styles.heading} id="signups-heading">
        Sign-ups
      </h2>
      <p className={styles.text}>
        New accounts wait here until you approve them. Unanswered ones expire after 30 days.
      </p>
      {signups.isPending && <Loading />}
      {signups.isError && <ErrorState error={signups.error} onRetry={() => void signups.refetch()} />}
      {signups.data?.length === 0 && <p className={styles.empty}>Nobody is waiting.</p>}
      {signups.data && signups.data.length > 0 && (
        <ul className={styles.list} aria-label="Sign-ups">
          {signups.data.map((signup) => (
            <li key={signup.id} className={styles.item}>
              <div className={styles.itemMain}>
                <span className={styles.itemTitle}>
                  {signup.displayName} <span className={styles.mono}>{signup.username}</span>
                </span>
                <span className={styles.itemMeta}>
                  Signed up {relativeTime(signup.createdAt)}, expires {absoluteTime(signup.expiresAt)}
                  {signup.note ? ` · "${signup.note}"` : ""}
                </span>
              </div>
              <div className={styles.actions}>
                <Button size="sm" variant="primary" onClick={() => approve.mutate(signup.id)}>
                  Approve
                </Button>
                <Button size="sm" variant="danger" onClick={() => reject.mutate(signup.id)}>
                  Reject
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {error && <p className={styles.error}>{errorMessage(error)}</p>}
    </section>
  );
}

const STATUS_TONE: Record<AdminAccount["status"], string> = {
  active: "good",
  pending: "warn",
  disabled: "bad",
};

function AccountsSection({ selfId }: { selfId: number }) {
  const accounts = useAdminAccounts();
  const action = useAccountAction();
  const resetLogin = useResetLogin();
  const [reset, setReset] = useState<{ username: string; result: ResetCodeResult } | null>(null);
  const [deleting, setDeleting] = useState<AdminAccount | null>(null);
  const [now] = useState(() => Date.now());
  const error = action.error ?? resetLogin.error;

  const run = (account: AdminAccount, act: AccountAction) => action.mutate({ id: account.id, action: act });
  const doReset = (account: AdminAccount) => {
    if (
      !window.confirm(
        `Reset the login of ${account.username}? Their password, authenticator and passkeys stop working.`,
      )
    )
      return;
    resetLogin.mutate(account.id, {
      onSuccess: (result) => setReset({ username: account.username, result }),
    });
  };

  return (
    <section className={styles.section} aria-labelledby="accounts-heading">
      <h2 className={styles.heading} id="accounts-heading">
        Accounts
      </h2>
      <p className={styles.text}>
        How people sign in and how much they store. Their todos and notes are not visible here.
      </p>
      {reset && (
        <div className={styles.form} style={{ marginBottom: 12 }}>
          <p className={styles.text}>
            Reset code for <span className={styles.mono}>{reset.username}</span>, valid until{" "}
            {absoluteTime(reset.result.expiresAt)}. Send it to them; they enter it on the reset page. It is
            shown only now.
          </p>
          <div className={styles.formRow}>
            <span className={styles.code}>{reset.result.resetCode}</span>
            <CopyButton text={reset.result.resetCode} label="Copy" />
            <Button size="sm" variant="ghost" onClick={() => setReset(null)}>
              Done
            </Button>
          </div>
        </div>
      )}
      {accounts.isPending && <Loading />}
      {accounts.isError && <ErrorState error={accounts.error} onRetry={() => void accounts.refetch()} />}
      {accounts.data && (
        <ul className={styles.list} aria-label="Accounts">
          {accounts.data
            .filter((a) => a.status !== "pending")
            .map((account) => {
              const self = account.id === selfId;
              const locked = account.lockedUntil !== null && Date.parse(account.lockedUntil) > now;
              return (
                <li key={account.id} className={styles.item}>
                  <div className={styles.itemMain}>
                    <span className={styles.itemTitle}>
                      {account.displayName} <span className={styles.mono}>{account.username}</span>{" "}
                      <span className={styles.badge} data-tone={STATUS_TONE[account.status]}>
                        {account.status}
                      </span>{" "}
                      {account.role === "admin" && <span className={styles.badge}>admin</span>}{" "}
                      {locked && (
                        <span className={styles.badge} data-tone="warn">
                          locked
                        </span>
                      )}{" "}
                      {account.resetPending && (
                        <span className={styles.badge} data-tone="warn">
                          reset pending
                        </span>
                      )}
                    </span>
                    <span className={styles.itemMeta}>
                      {methodsText(account)} · {account.activeSessions} sessions · files{" "}
                      {formatBytes(account.filesBytes)} · last sign-in{" "}
                      {account.lastLoginAt ? relativeTime(account.lastLoginAt) : "never"}
                    </span>
                  </div>
                  {!self && (
                    <div className={styles.actions}>
                      {locked && (
                        <Button size="sm" onClick={() => run(account, "unlock")}>
                          Unlock
                        </Button>
                      )}
                      <Button size="sm" onClick={() => doReset(account)}>
                        Reset login
                      </Button>
                      {account.status === "active" ? (
                        <Button size="sm" onClick={() => run(account, "disable")}>
                          Disable
                        </Button>
                      ) : (
                        <>
                          <Button size="sm" onClick={() => run(account, "enable")}>
                            Enable
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => setDeleting(account)}>
                            Delete
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
        </ul>
      )}
      {deleting && <DeleteAccountForm account={deleting} onDone={() => setDeleting(null)} />}
      {error && <p className={styles.error}>{errorMessage(error)}</p>}
    </section>
  );
}

function methodsText(account: AdminAccount): string {
  const parts: string[] = [];
  if (account.methods.password) parts.push("password");
  if (account.methods.totp) parts.push("authenticator");
  if (account.methods.passkeys > 0) parts.push(`${account.methods.passkeys} passkeys`);
  return parts.length > 0 ? parts.join(" + ") : "no sign-in method";
}

function DeleteAccountForm({ account, onDone }: { account: AdminAccount; onDone: () => void }) {
  const remove = useDeleteAccount();
  const [typed, setTyped] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    remove.mutate({ id: account.id, confirmUsername: typed.trim().toLowerCase() }, { onSuccess: onDone });
  };
  return (
    <form className={styles.form} style={{ marginTop: 12 }} onSubmit={submit}>
      <p className={styles.text}>
        Deletes <span className={styles.mono}>{account.username}</span> with all their data for good.
      </p>
      <Field label={`Type ${account.username} to confirm`}>
        <TextInput value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
      </Field>
      <div className={styles.formRow}>
        <Button
          type="submit"
          variant="danger"
          disabled={remove.isPending || typed.trim().toLowerCase() !== account.username}
        >
          Delete for good
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {remove.isError && <p className={styles.error}>{errorMessage(remove.error)}</p>}
    </form>
  );
}

function InstanceSection() {
  const instance = useInstance();
  const backup = useBackupNow();
  const data = instance.data;
  return (
    <section className={styles.section} aria-labelledby="instance-heading">
      <h2 className={styles.heading} id="instance-heading">
        Server and backups
      </h2>
      {instance.isPending && <Loading />}
      {instance.isError && <ErrorState error={instance.error} onRetry={() => void instance.refetch()} />}
      {data && (
        <>
          <div className={styles.stats}>
            <Stat label="Version" value={`${data.version} (schema ${data.schemaVersion})`} />
            <Stat
              label="Accounts"
              value={`${data.accounts.active} active, ${data.accounts.pending} waiting, ${data.accounts.disabled} disabled`}
            />
            <Stat label="Database" value={formatBytes(data.dbBytes)} />
            <Stat label="Files" value={formatBytes(data.filesBytes)} />
          </div>
          <p className={styles.text}>
            Daily backups of the whole server stay on the server (newest {data.backups.keep} kept). Last{" "}
            {data.backups.lastAt ? relativeTime(data.backups.lastAt) : "never"}
            {data.backups.nextAt ? `, next ${absoluteTime(data.backups.nextAt)}` : ""}.
          </p>
          {data.backups.files.length > 0 && (
            <ul className={styles.list} aria-label="Backups">
              {data.backups.files.map((file) => (
                <li key={file.fileName} className={styles.item}>
                  <div className={styles.itemMain}>
                    <span className={styles.mono}>{file.fileName}</span>
                    <span className={styles.itemMeta}>
                      {absoluteTime(file.createdAt)} · {formatBytes(file.bytes)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className={styles.formRow} style={{ marginTop: 10 }}>
            <Button onClick={() => backup.mutate()} disabled={backup.isPending}>
              Back up now
            </Button>
          </div>
          {backup.isError && <p className={styles.error}>{errorMessage(backup.error)}</p>}
        </>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  );
}

const ACTION_TEXT: Record<AdminEvent["action"], string> = {
  signup: "signed up",
  approve: "approved",
  reject: "rejected",
  disable: "disabled",
  enable: "enabled",
  reset_login: "reset the login of",
  unlock: "unlocked",
  delete: "deleted",
  expire_signup: "sign-up expired:",
  backup: "made a backup",
  setup_admin: "set up the first admin",
  make_admin: "made admin:",
};

function LogSection() {
  const events = useAdminEvents();
  return (
    <section className={styles.section} aria-labelledby="log-heading">
      <h2 className={styles.heading} id="log-heading">
        Log
      </h2>
      {events.isPending && <Loading />}
      {events.data?.length === 0 && <p className={styles.empty}>Nothing yet.</p>}
      {events.data && events.data.length > 0 && (
        <ul className={styles.list} aria-label="Admin log">
          {events.data.slice(0, 50).map((event) => (
            <li key={event.id} className={styles.item}>
              <span className={styles.itemMeta}>{absoluteTime(event.at)}</span>
              <span>
                <span className={styles.mono}>{event.actor}</span> {ACTION_TEXT[event.action]}{" "}
                {event.target && <span className={styles.mono}>{event.target}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
