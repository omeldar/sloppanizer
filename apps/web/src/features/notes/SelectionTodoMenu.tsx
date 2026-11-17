import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useCommands } from "../../app/commands.tsx";
import { readTextSelection, type TextSelection } from "../../components/markdown/selection.ts";
import { useKeys } from "../../keyboard/KeyboardProvider.tsx";
import { keyCaps } from "../../keyboard/keys.ts";
import styles from "./Notes.module.css";
import { type SelectionUse, selectionToTodo } from "./selectionTodo.ts";

const MENU_GAP = 6;
/** Room the menu needs below the selection before it goes above it instead. */
const MENU_HEIGHT = 36;
const MENU_WIDTH = 380;
const EDGE = 8;

const OPTIONS: { use: SelectionUse; label: string; keys: string }[] = [
  { use: "title", label: "Create Issue - Title", keys: "alt+shift+t" },
  { use: "description", label: "Create Issue - Description", keys: "alt+shift+d" },
];

/** Where the menu goes: below the end of the selection, above it near the bottom edge, inside the window. */
function menuPosition(rect: TextSelection["rect"]): { top: number; left: number } {
  const below = rect.bottom + MENU_GAP;
  const top = below + MENU_HEIGHT > window.innerHeight ? rect.top - MENU_GAP - MENU_HEIGHT : below;
  const left = Math.max(EDGE, Math.min(rect.left, window.innerWidth - MENU_WIDTH - EDGE));
  return { top: Math.max(EDGE, top), left };
}

/**
 * Wraps a note's text: selecting some of it (mouse, touch or keyboard) shows a small menu by the
 * selection that opens the new todo dialog with the text as title or description. Alt+Shift+T and
 * Alt+Shift+D do the same from the keyboard. Nothing is saved until the dialog is confirmed.
 */
export function SelectionTodoMenu({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<TextSelection | null>(null);
  const { openQuickAdd } = useCommands();

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The editor takes in the new selection on the same event; read it once that is done.
    const update = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setSelection(box.current ? readTextSelection(box.current) : null));
    };
    document.addEventListener("selectionchange", update);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, []);

  const create = (use: SelectionUse) => {
    const current = box.current ? readTextSelection(box.current) : null;
    if (!current) return;
    setSelection(null);
    openQuickAdd(selectionToTodo(current.text, use));
  };

  // Always on while the note is open (and listed in the key help); without selected text they do nothing.
  useKeys(
    OPTIONS.map((option) => ({
      keys: option.keys,
      run: () => create(option.use),
      label: option.label,
      group: "Note",
      whileTyping: true,
    })),
  );

  const position = selection ? menuPosition(selection.rect) : null;
  return (
    <div ref={box}>
      {children}
      {position &&
        createPortal(
          <div
            className={styles.selectionMenu}
            role="group"
            aria-label="Selected text"
            style={{ top: position.top, left: position.left }}
          >
            {OPTIONS.map((option) => (
              <button
                key={option.use}
                type="button"
                className={styles.selectionAction}
                title={keyCaps(option.keys).join("+")}
                aria-keyshortcuts={keyCaps(option.keys).join("+")}
                // Keeps the selection: a press on the menu must not clear it before the click.
                onPointerDown={(event) => event.preventDefault()}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => create(option.use)}
              >
                {option.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
