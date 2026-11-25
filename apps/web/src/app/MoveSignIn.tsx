import type { AuthConfig } from "@organizer/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Dialog, DialogActions, DialogBody } from "../components/Dialog.tsx";
import { useToast } from "../components/toast/ToastProvider.tsx";
import { Button } from "../components/ui.tsx";
import { accountKeys, useAccountProfile } from "../lib/accountQueries.ts";
import { errorMessage } from "../lib/api.ts";
import { authConfig } from "../lib/auth.ts";
import { formatDate } from "../lib/format.ts";
import { moveSignInToOmeldar, type OmeldarConfig } from "../lib/omeldar.ts";
import { useNow } from "../lib/useNow.ts";
import authStyles from "../features/auth/Auth.module.css";
import styles from "./Layout.module.css";

/** After "Later" the banner stays away this long, then asks again. */
export const SNOOZE_MS = 24 * 60 * 60_000;
/** From this close to the end, the banner turns amber. */
const SOON_MS = 7 * 24 * 60 * 60_000;

const snoozeKey = (accountId: number) => `sloppanizer.moveSignIn.later.${accountId}`;

function snoozedUntil(accountId: number): number {
  try {
    return Number(localStorage.getItem(snoozeKey(accountId)) ?? 0) || 0;
  } catch {
    return 0;
  }
}

function snooze(accountId: number, now: number): void {
  try {
    localStorage.setItem(snoozeKey(accountId), String(now + SNOOZE_MS));
  } catch {
    // No storage: the banner just stays.
  }
}

export interface MoveSignInState {
  omeldar: OmeldarConfig;
  username: string;
  accountId: number;
  /** The day the own login stops, or null when no day is set. */
  endsOn: string | null;
  ended: boolean;
  soon: boolean;
}

/**
 * Whether this account still signs in with its Sloppanizer password while omeldar is offered next to it
 * (SLOPPANIZER_AUTH=both), and when that ends. Null for accounts that already moved, or when there is
 * nothing to move to.
 */
export function useMoveSignIn(): MoveSignInState | null {
  const now = useNow();
  const config = useQuery({ queryKey: ["auth-config"], queryFn: authConfig, staleTime: Infinity });
  const profile = useAccountProfile();
  return moveSignInState(config.data, profile.data, now);
}

export function moveSignInState(
  config: AuthConfig | undefined,
  profile: { id: number; username: string; omeldarLinked: boolean } | undefined,
  now: number,
): MoveSignInState | null {
  if (!config?.omeldar || config.mode !== "both" || !profile || profile.omeldarLinked) return null;
  const ends = config.localLoginEnds ?? null;
  const left = ends ? Date.parse(ends.at) - now : Infinity;
  return {
    omeldar: config.omeldar,
    username: profile.username,
    accountId: profile.id,
    endsOn: ends?.on ?? null,
    ended: left <= 0,
    soon: left <= SOON_MS,
  };
}

/** The banner's sentence about the end of the own login. */
function endText(state: MoveSignInState): string {
  if (!state.endsOn)
    return "Move your sign-in to your omeldar account, the one sign-in for every omeldar site.";
  const day = formatDate(state.endsOn);
  if (state.ended) {
    return `Sign-in with your Sloppanizer password ended on ${day}. Move your sign-in to omeldar now: once you sign out, you cannot sign in here again without it.`;
  }
  return `Sign-in with your Sloppanizer password ends on ${day}. Move your sign-in to your omeldar account before then.`;
}

/**
 * A line under the top bar for accounts that still sign in with their Sloppanizer password: move to
 * auth.omeldar.com. "Later" hides it for a day; once the own login has ended it stays.
 */
export function MoveSignInBanner() {
  const now = useNow();
  const state = useMoveSignIn();
  const [open, setOpen] = useState(false);
  // "Later" pressed in this page: hidden right away, until the next day (the minute clock then shows it).
  const [laterAt, setLaterAt] = useState(0);
  if (!state) return null;
  const hidden = !state.ended && Math.max(snoozedUntil(state.accountId), laterAt + SNOOZE_MS) > now;
  return (
    <>
      {!hidden && (
        <div className={styles.banner} role="status" data-tone={state.soon ? "amber" : undefined}>
          <span>
            {state.soon && <span className={styles.bannerDot} aria-hidden="true" />}
            {endText(state)} Your data stays.
          </span>
          <span className={styles.bannerActions}>
            <button type="button" className={styles.bannerAction} onClick={() => setOpen(true)}>
              Move my sign-in
            </button>
            {!state.ended && (
              <button
                type="button"
                className={styles.bannerLater}
                onClick={() => {
                  const at = Date.now();
                  snooze(state.accountId, at);
                  setLaterAt(at);
                }}
              >
                Later
              </button>
            )}
          </span>
        </div>
      )}
      <MoveSignInDialog state={state} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** What moving means, and the step to omeldar (a popup; Sloppanizer may first ask to confirm it is you). */
export function MoveSignInDialog({
  state,
  open,
  onOpenChange,
}: {
  state: MoveSignInState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      if (await moveSignInToOmeldar(state.omeldar, state.username)) {
        onOpenChange(false);
        toast.show({ message: 'Your sign-in moved to omeldar. Next time, use "Sign in with omeldar".' });
        await client.invalidateQueries({ queryKey: accountKeys.profile });
      }
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
      title="Move your sign-in to omeldar"
      description="You then sign in at auth.omeldar.com, with one account for every omeldar site."
      width={460}
    >
      <DialogBody>
        <ul className={styles.moveList}>
          <li>Your todos, notes, API tokens and connected apps stay as they are.</li>
          <li>
            At omeldar, sign in with your omeldar account. If the admin moved your account there, it has your
            Sloppanizer username and password.
          </li>
          <li>Sloppanizer may first ask you to confirm it is you.</li>
        </ul>
        {state.endsOn && (
          <p className={styles.moveNote}>
            {state.ended
              ? "Sign-in with your Sloppanizer password ended on "
              : "Sign-in with your Sloppanizer password ends on "}
            {formatDate(state.endsOn)}.
          </p>
        )}
        {error && (
          <p className={authStyles.alert} role="alert">
            {error}
          </p>
        )}
        <DialogActions>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={() => void run()}>
            Continue at omeldar
          </Button>
        </DialogActions>
      </DialogBody>
    </Dialog>
  );
}
