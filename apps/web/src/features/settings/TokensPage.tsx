import type { ApiToken, TokenScope } from "@organizer/shared";
import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Dialog, DialogBody, DialogActions } from "../../components/Dialog.tsx";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  PageHeader,
  TextInput,
} from "../../components/ui.tsx";
import { type KeyBinding, useKeys } from "../../keyboard/KeyboardProvider.tsx";
import { errorMessage } from "../../lib/api.ts";
import { absoluteTime, relativeTime } from "../../lib/format.ts";
import { createToken, useRevokeToken, useTokens } from "../../lib/queries.ts";
import { useNow } from "../../lib/useNow.ts";
import { stepCursor, useScrollIntoView } from "../../lib/listCursor.ts";
import { SessionOnly } from "./SessionOnly.tsx";
import styles from "./Tokens.module.css";

const SCOPES: { value: TokenScope; name: string; note: string }[] = [
  { value: "read", name: "Read", note: "Can look at everything." },
  { value: "write", name: "Write", note: "Can also change things." },
];

const EXPIRY_DAYS = [
  { value: "never", label: "Never" },
  { value: "30", label: "In 30 days" },
  { value: "90", label: "In 90 days" },
  { value: "365", label: "In 365 days" },
] as const;

type Expiry = (typeof EXPIRY_DAYS)[number]["value"];

const DAY_MS = 86_400_000;

export function expiresAtFor(expiry: Expiry, now: Date = new Date()): string | null {
  return expiry === "never" ? null : new Date(now.getTime() + Number(expiry) * DAY_MS).toISOString();
}

/** A token that still works: not revoked and not past its expiry. */
export function isActive(token: ApiToken, now: Date = new Date()): boolean {
  return (
    token.revokedAt === null && (token.expiresAt === null || Date.parse(token.expiresAt) > now.getTime())
  );
}

/** Shown once after creating a token; lives only in this page's state. */
interface Created {
  name: string;
  raw: string;
}

export function TokensPage() {
  return (
    <SessionOnly>
      <TokensView />
    </SessionOnly>
  );
}

function TokensView() {
  const tokens = useTokens();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const now = new Date(useNow());
  const all = tokens.data ?? [];
  const active = all.filter((t) => isActive(t, now));
  const inactive = all.filter((t) => !isActive(t, now));
  const index = active.findIndex((t) => t.id === selectedId);
  const move = (delta: number) =>
    setSelectedId(
      stepCursor(
        active.map((t) => t.id),
        selectedId,
        delta,
      ),
    );
  const bindings: KeyBinding[] = [
    { keys: "j", run: () => move(1), label: "Next token", group: "API tokens" },
    { keys: "k", run: () => move(-1), label: "Previous token", group: "API tokens" },
    { keys: "ArrowDown", run: () => move(1) },
    { keys: "ArrowUp", run: () => move(-1) },
    { keys: "a", run: () => setCreating(true), label: "New token", group: "API tokens" },
    {
      keys: "r",
      run: () => {
        const token = active[index];
        if (token) setRevoking(token);
      },
      label: "Revoke the selected token",
      group: "API tokens",
    },
  ];
  useKeys(bindings);

  return (
    <div className={styles.page}>
      <PageHeader
        title="API tokens"
        meta={tokens.data ? `${active.length} active` : undefined}
        actions={
          <Button variant="primary" hint="a" onClick={() => setCreating(true)}>
            New token
          </Button>
        }
      />
      <p className={styles.intro}>
        Programs like the MCP server sign in with a token. Tokens can never open this page, restore data or
        change settings.
      </p>

      {created && <CreatedPanel created={created} onClose={() => setCreated(null)} />}

      {tokens.isPending && <Loading />}
      {tokens.isError && <ErrorState error={tokens.error} onRetry={() => void tokens.refetch()} />}
      {tokens.data && active.length === 0 && (
        <EmptyState>No active tokens. Choose New token to let a program reach Sloppanizer.</EmptyState>
      )}
      {active.length > 0 && (
        <TokenTable
          label="Active tokens"
          tokens={active}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onRevoke={setRevoking}
        />
      )}
      {inactive.length > 0 && (
        <details className={styles.inactive}>
          <summary className={styles.summary}>Revoked and expired ({inactive.length})</summary>
          <TokenTable label="Revoked and expired tokens" tokens={inactive} />
        </details>
      )}

      <Dialog open={creating} onOpenChange={setCreating} title="New token" width={480}>
        {creating && (
          <NewTokenForm
            onCancel={() => setCreating(false)}
            onCreated={(next) => {
              setCreating(false);
              setCreated(next);
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`Revoke ${revoking?.name ?? ""}?`}
        description="Programs using this token stop working right away."
        width={440}
      >
        {revoking && <RevokeActions token={revoking} onDone={() => setRevoking(null)} />}
      </Dialog>
    </div>
  );
}

function CreatedPanel({ created, onClose }: { created: Created; onClose: () => void }) {
  const toast = useToast();
  const copy = () =>
    void navigator.clipboard
      .writeText(created.raw)
      .then(() => toast.show({ message: `Copied the token ${created.name}` }))
      .catch(() =>
        toast.show({ tone: "error", message: "Could not copy. Select the token and copy it by hand." }),
      );
  return (
    <section className={styles.created} aria-label={`New token ${created.name}`}>
      <h2 className={styles.createdTitle}>New token {created.name}</h2>
      <p className={styles.createdNote}>Copy it now. It is not shown again.</p>
      <div className={styles.rawRow}>
        <code className={styles.raw}>{created.raw}</code>
        <Button variant="primary" onClick={copy}>
          Copy
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      </div>
    </section>
  );
}

function TokenTable({
  label,
  tokens,
  selectedId,
  onSelect,
  onRevoke,
}: {
  label: string;
  tokens: ApiToken[];
  selectedId?: number | null;
  onSelect?: (id: number) => void;
  onRevoke?: (token: ApiToken) => void;
}) {
  return (
    <ol className={styles.bay} aria-label={label}>
      <li className={styles.header} aria-hidden="true">
        <span>Name</span>
        <span>Starts with</span>
        <span>Scope</span>
        <span>Created</span>
        <span>Last used</span>
        <span>{onRevoke ? "Expires" : "Ended"}</span>
        <span />
      </li>
      {tokens.map((token) => (
        <TokenRow
          key={token.id}
          token={token}
          selected={token.id === selectedId}
          onSelect={onSelect ? () => onSelect(token.id) : undefined}
          onRevoke={onRevoke ? () => onRevoke(token) : undefined}
        />
      ))}
    </ol>
  );
}

function TokenRow({
  token,
  selected,
  onSelect,
  onRevoke,
}: {
  token: ApiToken;
  selected: boolean;
  onSelect?: () => void;
  onRevoke?: () => void;
}) {
  const ref = useScrollIntoView<HTMLLIElement>(selected);
  const end = onRevoke
    ? token.expiresAt
      ? absoluteTime(token.expiresAt)
      : "Never"
    : token.revokedAt
      ? `Revoked ${absoluteTime(token.revokedAt)}`
      : `Expired ${absoluteTime(token.expiresAt ?? token.createdAt)}`;
  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- a click moves the list cursor (j/k do the same by keyboard)
    <li ref={ref} className={styles.row} data-selected={selected || undefined} onMouseDown={onSelect}>
      <span className={styles.name}>{token.name}</span>
      <span className={styles.mono}>{token.prefix}</span>
      <span className={styles.scope} data-scope={token.scope}>
        {token.scope === "write" ? "Write" : "Read"}
      </span>
      <span className={styles.mono}>
        <time dateTime={token.createdAt}>{absoluteTime(token.createdAt)}</time>
      </span>
      <span className={styles.mono} title={token.lastUsedAt ? absoluteTime(token.lastUsedAt) : undefined}>
        {token.lastUsedAt ? relativeTime(token.lastUsedAt) : "Never"}
      </span>
      <span className={styles.mono}>{end}</span>
      <span className={styles.actions}>
        {onRevoke && (
          <Button size="sm" variant="ghost" onClick={onRevoke}>
            Revoke
          </Button>
        )}
      </span>
    </li>
  );
}

function NewTokenForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (created: Created) => void;
}) {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<TokenScope>("read");
  const [expiry, setExpiry] = useState<Expiry>("never");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await createToken(client, {
        name: name.trim(),
        scope,
        expiresAt: expiresAtFor(expiry),
      });
      onCreated({ name: result.token.name, raw: result.raw });
    } catch (failure) {
      setError(errorMessage(failure));
      setPending(false);
    }
  };

  return (
    <DialogBody onSubmit={submit}>
      <Field label="Name" hint="Where the token is used, e.g. MCP on the laptop.">
        {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog opens to type a name */}
        <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus />
      </Field>
      <fieldset className={styles.scopes}>
        <legend className={styles.legend}>Scope</legend>
        {SCOPES.map((option) => (
          <label
            key={option.value}
            className={styles.scopeOption}
            data-on={scope === option.value || undefined}
          >
            <input
              type="radio"
              name="scope"
              value={option.value}
              checked={scope === option.value}
              onChange={() => setScope(option.value)}
            />
            <span className={styles.scopeName}>{option.name}:</span>
            <span className={styles.scopeNote}>{option.note}</span>
          </label>
        ))}
      </fieldset>
      <Field label="Expires">
        <select
          className={styles.select}
          value={expiry}
          onChange={(e) => setExpiry(e.target.value as Expiry)}
        >
          {EXPIRY_DAYS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!name.trim() || pending}>
          Create token
        </Button>
      </DialogActions>
    </DialogBody>
  );
}

function RevokeActions({ token, onDone }: { token: ApiToken; onDone: () => void }) {
  const revoke = useRevokeToken();
  const toast = useToast();
  return (
    <DialogActions>
      <Button onClick={onDone}>Keep it</Button>
      <Button
        variant="danger"
        disabled={revoke.isPending}
        onClick={async () => {
          try {
            await revoke.mutateAsync(token.id);
            toast.show({ message: `Revoked ${token.name}` });
            onDone();
          } catch (error) {
            toast.show({ tone: "error", message: `Could not revoke ${token.name}. ${errorMessage(error)}` });
          }
        }}
      >
        Revoke token
      </Button>
    </DialogActions>
  );
}
