/** Key notation: "x", "Enter", "ctrl+k", "mod+Enter" (ctrl or cmd), sequences with a space: "g n". */
export interface Chord {
  key: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  mod: boolean;
}

export function parseChord(text: string): Chord {
  const parts = text.split("+");
  // "+" itself as a key: "shift++" is not used; a lone "+" stays a key.
  const key = parts.length > 1 && parts.at(-1) === "" ? "+" : (parts.pop() ?? "");
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  return { key, ctrl: mods.has("ctrl"), meta: mods.has("meta"), alt: mods.has("alt"), mod: mods.has("mod") };
}

export function parseKeys(text: string): Chord[] {
  return text.trim().split(/\s+/).map(parseChord);
}

export function matchesChord(
  chord: Chord,
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">,
): boolean {
  const ctrl = chord.ctrl || (chord.mod && !event.metaKey);
  const meta = chord.meta || (chord.mod && event.metaKey);
  if (event.ctrlKey !== ctrl || event.metaKey !== meta || event.altKey !== chord.alt) return false;
  // Letters ignore case when a modifier is held (ctrl+K with caps lock); printable keys compare exactly otherwise.
  if (chord.key.length === 1 && (ctrl || meta)) return event.key.toLowerCase() === chord.key.toLowerCase();
  return event.key === chord.key;
}

const EDITABLE = '[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

/** Elements where typed keys belong to the text, not to shortcuts. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(".cm-editor")) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color"].includes(target.type);
  }
  return target instanceof HTMLElement && (target.isContentEditable || target.closest(EDITABLE) !== null);
}

/** Display form for hints: "ctrl+k" -> ["Ctrl", "K"], "g n" -> ["g", "n"]. */
export function keyCaps(text: string): string[] {
  return parseKeys(text).flatMap((chord) => {
    const caps: string[] = [];
    if (chord.ctrl || chord.mod) caps.push("Ctrl");
    if (chord.meta) caps.push("Cmd");
    if (chord.alt) caps.push("Alt");
    const name =
      chord.key === "Escape"
        ? "Esc"
        : chord.key === "ArrowDown"
          ? "Down"
          : chord.key === "ArrowUp"
            ? "Up"
            : chord.key;
    caps.push(caps.length > 0 && name.length === 1 ? name.toUpperCase() : name);
    return caps;
  });
}
