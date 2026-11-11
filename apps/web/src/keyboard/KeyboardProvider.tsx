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
  mode: KeyMode;
  /** Keys typed so far of an unfinished sequence, e.g. "g". */
  pending: string;
  activeBindings: () => KeyBinding[];
}

const KeyboardContext = createContext<KeyboardState | null>(null);

const SEQUENCE_TIMEOUT_MS = 1500;
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

type Pressed = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">;

export function KeyboardProvider({ children }: { children: ReactNode }) {
  const layers = useRef<Layer[]>([]);
  const pendingRef = useRef<Pressed[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [mode, setMode] = useState<KeyMode>("normal");
  const [pending, setPending] = useState("");

  const register = useCallback((layer: Layer) => {
    layers.current = [...layers.current, layer];
    return () => {
      layers.current = layers.current.filter((l) => l !== layer);
    };
  }, []);

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
  }, [activeBindings]);

  const value = useMemo(
    () => ({ register, mode, pending, activeBindings }),
    [register, mode, pending, activeBindings],
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

export function useKeyMode(): { mode: KeyMode; pending: string } {
  const { mode, pending } = useKeyboard();
  return { mode, pending };
}

export function useActiveBindings(): () => KeyBinding[] {
  return useKeyboard().activeBindings;
}
