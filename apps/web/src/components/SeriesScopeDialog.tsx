import type { SeriesScope } from "@organizer/shared";
import { useState } from "react";
import { Dialog, DialogActions, DialogBody } from "./Dialog.tsx";
import styles from "./SeriesScope.module.css";
import { Button } from "./ui.tsx";

export interface ScopeOption {
  scope: SeriesScope;
  /** Why the choice is off (it stays visible with this hint), or null when it can be picked. */
  off?: string | null;
  /** A line under the choice, e.g. which dates "All" changes on a split repeat. */
  hint?: string;
  /** Instead of "This one only", "This and following" or "All". */
  label?: string;
}

const LABELS: Record<SeriesScope, string> = {
  this: "This one only",
  following: "This and following",
  all: "All",
};

/**
 * Asks which dates of a repeating thing a change is for: this one only, this and following, or all.
 * Used for meetings now and for repeating planner blocks later. Cancel leaves everything as it was.
 */
export function SeriesScopeDialog({
  open,
  title,
  description,
  options,
  confirmLabel = "Save",
  danger = false,
  busy = false,
  error,
  onPick,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: string;
  options: readonly ScopeOption[];
  confirmLabel?: string;
  /** The change removes something (cancel dates). */
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onPick: (scope: SeriesScope) => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onCancel()}
      title={title}
      {...(description ? { description } : {})}
      width={420}
    >
      {open && (
        <ScopeForm
          options={options}
          confirmLabel={confirmLabel}
          danger={danger}
          busy={busy}
          error={error ?? null}
          onPick={onPick}
          onCancel={onCancel}
        />
      )}
    </Dialog>
  );
}

function ScopeForm({
  options,
  confirmLabel,
  danger,
  busy,
  error,
  onPick,
  onCancel,
}: {
  options: readonly ScopeOption[];
  confirmLabel: string;
  danger: boolean;
  busy: boolean;
  error: string | null;
  onPick: (scope: SeriesScope) => void;
  onCancel: () => void;
}) {
  const [scope, setScope] = useState<SeriesScope>(
    () => options.find((o) => !o.off)?.scope ?? options[0]?.scope ?? "this",
  );
  return (
    <DialogBody
      onSubmit={(event) => {
        event.preventDefault();
        // The dialog may open from inside another form; its submit stays here.
        event.stopPropagation();
        onPick(scope);
      }}
    >
      <fieldset className={styles.choices}>
        <legend className="visually-hidden">Which dates</legend>
        {options.map((option) => (
          <label key={option.scope} className={styles.choice} data-off={option.off ? true : undefined}>
            <input
              type="radio"
              name="scope"
              value={option.scope}
              checked={scope === option.scope}
              disabled={Boolean(option.off)}
              onChange={() => setScope(option.scope)}
            />
            <span className={styles.text}>
              <span className={styles.label}>{option.label ?? LABELS[option.scope]}</span>
              {(option.off || option.hint) && (
                <span className={styles.hint}>{option.off || option.hint}</span>
              )}
            </span>
          </label>
        ))}
      </fieldset>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <DialogActions>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant={danger ? "danger" : "primary"} disabled={busy}>
          {confirmLabel}
        </Button>
      </DialogActions>
    </DialogBody>
  );
}
