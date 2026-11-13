import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type Chord, isTypingTarget, matchesChord, parseKeys } from "./keys.ts";

export interface KeyBinding {
  /** See keys.ts for the notation. */
  keys: string;
  run: (event: KeyboardEvent) => void;
  /** Shown in the help overlay when set. */
  label?: string;
  group?: string;
  /** Also fires while the focus is in a text field (insert mode). Off by default. */
  whileTyping?: boolean;
}

interface Layer {
  bindings: { current: readonly KeyBinding[] };
  enabled: { current: boolean };
  /** A modal layer (dialog, overlay) hides every layer below it. */
  modal: boolean;
}

export type KeyMode = "normal" | "insert";

interface KeyboardState {
  register: (layer: Layer) => () => void;
  /** Holds keys nobody handles until the release; see useKeyHold. */
  hold: () => () => void;
  mode: KeyMode;
  /** Keys typed so far of an unfinished sequence, e.g. "g". */
  pending: string;
  activeBindings: () => KeyBinding[];
}

const KeyboardContext = createContext<KeyboardState | null>(null);

const SEQUENCE_TIMEOUT_MS = 1500;
/** How long held keys wait after the hold ends for the page that loaded to take them. */
const HELD_KEYS_GRACE_MS = 1000;
/** A few keys at most: a short burst typed while a page loads, not a backlog. */
const MAX_HELD_KEYS = 3;
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

type Pressed = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">;

export function KeyboardProvider({ children }: { children: ReactNode }) {
  const layers = useRef<Layer[]>([]);
  const pendingRef = useRef<Pressed[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [mode, setMode] = useState<KeyMode>("normal");
  const [pending, setPending] = useState("");
  // Keys pressed while a page loads (no layer took them), replayed when its layer registers.
  const holds = useRef(0);
  const releasedAt = useRef(0);
  const held = useRef<Pressed[]>([]);

  const heldKeys = useCallback((): Pressed[] => {
    if (holds.current === 0 && Date.now() - releasedAt.current > HELD_KEYS_GRACE_MS) held.current = [];
    return held.current;
  }, []);

  const hold = useCallback(() => {
    holds.current += 1;
    return () => {
      holds.current -= 1;
      releasedAt.current = Date.now();
    };
  }, []);

  const register = useCallback(
    (layer: Layer) => {
      layers.current = [...layers.current, layer];
      // A held key goes to the first new layer that has a single key binding for it.
      if (layer.enabled.current && heldKeys().length > 0) {
        const left: Pressed[] = [];
        for (const pressed of held.current) {
          const binding = layer.bindings.current.find((b) => {
            const chords = parseKeys(b.keys);
            return chords.length === 1 && matchesChord(chords[0] as Chord, pressed);
          });
          if (binding) binding.run(new KeyboardEvent("keydown", pressed));
          else left.push(pressed);
        }
        held.current = left;
      }
      return () => {
        layers.current = layers.current.filter((l) => l !== layer);
      };
    },
    [heldKeys],
  );

  /** Enabled layers from the top down to (and including) the first modal one. */
  const visibleLayers = useCallback((): Layer[] => {
    const result: Layer[] = [];
    for (const layer of layers.current.toReversed()) {
      if (!layer.enabled.current) continue;
      result.push(layer);
      if (layer.modal) break;
    }
    return result;
  }, []);

  const activeBindings = useCallback(
    () => visibleLayers().flatMap((layer) => layer.bindings.current),
    [visibleLayers],
  );

  useEffect(() => {
    const setSequence = (next: Pressed[]) => {
      pendingRef.current = next;
      setPending(next.map((p) => p.key).join(" "));
      clearTimeout(timer.current);
      if (next.length > 0) timer.current = setTimeout(() => setSequence([]), SEQUENCE_TIMEOUT_MS);
    };

    const find = (pressed: Pressed[], typing: boolean) => {
      let exact: KeyBinding | undefined;
      let prefix = false;
      for (const binding of activeBindings()) {
        if (typing && !binding.whileTyping) continue;
        const chords: Chord[] = parseKeys(binding.keys);
        if (chords.length < pressed.length) continue;
        if (!pressed.every((p, i) => matchesChord(chords[i] as Chord, p))) continue;
        if (chords.length === pressed.length) exact ??= binding;
        else prefix = true;
      }
      return { exact, prefix };
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || MODIFIER_KEYS.has(event.key)) return;
      const typing = isTypingTarget(event.target);
      const pressed: Pressed = {
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
      };

      if (pendingRef.current.length > 0) {
        const sequence = [...pendingRef.current, pressed];
        const { exact, prefix } = find(sequence, typing);
        if (exact) {
          setSequence([]);
          event.preventDefault();
          exact.run(event);
          return;
        }
        if (prefix) {
          setSequence(sequence);
          event.preventDefault();
          return;
        }
        setSequence([]);
      }

      const { exact, prefix } = find([pressed], typing);
      if (exact) {
        event.preventDefault();
        exact.run(event);
      } else if (prefix) {
        event.preventDefault();
        setSequence([pressed]);
      } else if (holds.current > 0 && !typing && heldKeys().length < MAX_HELD_KEYS) {
        event.preventDefault();
        held.current = [...held.current, pressed];
      }
    };

    const onFocusIn = (event: FocusEvent) => setMode(isTypingTarget(event.target) ? "insert" : "normal");
    const onFocusOut = (event: FocusEvent) =>
      setMode(isTypingTarget(event.relatedTarget) ? "insert" : "normal");

    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      clearTimeout(timer.current);
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [activeBindings, heldKeys]);

  const value = useMemo(
    () => ({ register, hold, mode, pending, activeBindings }),
    [register, hold, mode, pending, activeBindings],
  );
  return <KeyboardContext.Provider value={value}>{children}</KeyboardContext.Provider>;
}

function useKeyboard(): KeyboardState {
  const state = useContext(KeyboardContext);
  if (!state) throw new Error("useKeys needs a KeyboardProvider above it.");
  return state;
}

/**
 * Registers shortcuts while the component is mounted. Later layers win over earlier ones;
 * a modal layer (dialogs, overlays) switches off everything below it.
 */
export function useKeys(
  bindings: readonly KeyBinding[],
  options: { enabled?: boolean; modal?: boolean } = {},
): void {
  const { register } = useKeyboard();
  const bindingsRef = useRef(bindings);
  const enabledRef = useRef(options.enabled ?? true);
  useEffect(() => {
    bindingsRef.current = bindings;
    enabledRef.current = options.enabled ?? true;
  });
  const modal = options.modal ?? false;
  useEffect(() => register({ bindings: bindingsRef, enabled: enabledRef, modal }), [register, modal]);
}

/**
 * While `active` (a page or its data still loading), single keys no shortcut takes are kept, and the
 * first layer that registers with a binding for them runs it, up to a second after the hold ends.
 * So "m" pressed right after opening a todo still focuses the comment box once the page is there.
 */
export function useKeyHold(active: boolean): void {
  const { hold } = useKeyboard();
  useEffect(() => (active ? hold() : undefined), [active, hold]);
}

export function useKeyMode(): { mode: KeyMode; pending: string } {
  const { mode, pending } = useKeyboard();
  return { mode, pending };
}

export function useActiveBindings(): () => KeyBinding[] {
  return useKeyboard().activeBindings;
}
