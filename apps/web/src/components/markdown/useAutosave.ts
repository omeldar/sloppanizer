import { useCallback, useEffect, useRef, useState } from "react";

/** Pause after the last keystroke before the text is saved. */
export const SAVE_DELAY_MS = 700;

export type SaveState = "idle" | "saved" | "pending" | "saving";

/**
 * Text that saves itself: `change` saves after a pause, `flush` saves now, and unsaved text is saved when
 * the component goes away. One save runs at a time and only the newest text waits behind it, so the
 * server gets the edits in order. A new `value` from outside (another tab, MCP, a checklist click)
 * replaces the text unless there are unsaved edits.
 */
export function useAutosave(
  value: string,
  persist: (text: string) => Promise<boolean>,
  delayMs = SAVE_DELAY_MS,
) {
  const [draft, setDraft] = useState(value);
  // "idle" until the first change, so untouched text shows no save state.
  const [state, setState] = useState<SaveState>("idle");
  // For the async code: the newest text and save function, and what the server has.
  const latest = useRef({ draft: value, persist });
  const saved = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef(false);
  const queued = useRef<string | null>(null);
  useEffect(() => {
    latest.current.persist = persist;
  });

  const save = useCallback(async (text: string): Promise<void> => {
    clearTimeout(timer.current);
    if (inFlight.current) {
      queued.current = text;
      return;
    }
    inFlight.current = true;
    let next: string | null = text;
    try {
      while (next !== null && next !== saved.current) {
        const sending: string = next;
        setState("saving");
        try {
          // oxlint-disable-next-line no-await-in-loop -- one save at a time, in order
          if (await latest.current.persist(sending)) saved.current = sending;
        } catch {
          // Stays unsaved; the caller already showed why.
        }
        next = queued.current;
        queued.current = null;
      }
    } finally {
      inFlight.current = false;
    }
    const clean = latest.current.draft === saved.current;
    setState((current) => (!clean ? "pending" : current === "idle" ? "idle" : "saved"));
  }, []);

  const change = useCallback(
    (text: string) => {
      latest.current.draft = text;
      setDraft(text);
      setState("pending");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(text), delayMs);
    },
    [save, delayMs],
  );

  const flush = useCallback(() => void save(latest.current.draft), [save]);

  // Leaving the page (Back, a link) must not drop the last keystrokes.
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (latest.current.draft !== saved.current) void save(latest.current.draft);
    },
    [save],
  );

  // The text changed elsewhere: show it, unless there are edits or a save on the way (those win; the
  // answer to our save brings the value back in line).
  useEffect(() => {
    if (value === saved.current) return;
    if (latest.current.draft !== saved.current || inFlight.current) return;
    saved.current = value;
    latest.current.draft = value;
    setDraft(value);
  }, [value]);

  return { draft, state, change, flush };
}
