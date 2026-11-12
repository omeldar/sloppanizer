import { type Ref, useEffect, useRef, useState } from "react";
import { MarkdownEditor, type MarkdownEditorHandle } from "./MarkdownEditor.tsx";
import styles from "./Markdown.module.css";
import { MarkdownPreview } from "./MarkdownPreview.tsx";

/** Pause after the last keystroke before the text is saved. */
export const SAVE_DELAY_MS = 700;
const SAVE_STATE_TEXT = { idle: "", saved: "Saved", pending: "Not saved yet", saving: "Saving" } as const;

interface Props {
  title: string;
  value: string;
  /** Saves the text; resolves false when it failed (the caller shows why). */
  save: (text: string) => Promise<boolean>;
  /** Shown in preview mode when there is no text. */
  emptyText: string;
  /** Start in write mode even with text (e.g. a note that was just created). */
  startWriting?: boolean;
  autoFocus?: boolean;
  editorRef?: Ref<MarkdownEditorHandle>;
}

/**
 * A titled Markdown block with Write and Preview that saves itself: after a short pause, on blur and
 * when switching to Preview. Used for todo descriptions, notes and person notes.
 */
export function MarkdownField({
  title,
  value,
  save: persist,
  emptyText,
  startWriting = false,
  autoFocus = false,
  editorRef,
}: Props) {
  const [editing, setEditing] = useState(startWriting || value === "");
  const [draft, setDraft] = useState(value);
  // "idle" until the first change, so untouched text shows no save state.
  const [state, setState] = useState<"idle" | "saved" | "pending" | "saving">("idle");
  const saved = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const save = async (text: string) => {
    clearTimeout(timer.current);
    if (text === saved.current) {
      setState((current) => (current === "idle" ? "idle" : "saved"));
      return;
    }
    setState("saving");
    const ok = await persist(text);
    if (ok) saved.current = text;
    setState(ok ? "saved" : "pending");
  };

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <>
      <div className={styles.fieldHead}>
        <h2 className={styles.fieldTitle}>{title}</h2>
        <span className={styles.saveState} aria-live="polite">
          {editing && SAVE_STATE_TEXT[state]}
        </span>
        <div className={styles.toggle} role="group" aria-label={`${title} view`}>
          <button type="button" aria-pressed={editing} onClick={() => setEditing(true)}>
            Write
          </button>
          <button
            type="button"
            aria-pressed={!editing}
            onClick={() => {
              void save(draft);
              setEditing(false);
            }}
          >
            Preview
          </button>
        </div>
      </div>
      {editing ? (
        <MarkdownEditor
          ref={editorRef}
          label={title}
          value={draft}
          autoFocus={autoFocus}
          onChange={(text) => {
            setDraft(text);
            setState("pending");
            clearTimeout(timer.current);
            timer.current = setTimeout(() => void save(text), SAVE_DELAY_MS);
          }}
          onBlur={() => void save(draft)}
        />
      ) : draft.trim() ? (
        <MarkdownPreview source={draft} />
      ) : (
        <p className={styles.emptyText}>{emptyText}</p>
      )}
    </>
  );
}
