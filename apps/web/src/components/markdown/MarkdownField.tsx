import { type ReactNode, type Ref, useEffect, useRef, useState } from "react";
import { MarkdownEditor, type MarkdownEditorHandle } from "./MarkdownEditor.tsx";
import styles from "./Markdown.module.css";
import { type ChecklistControl, MarkdownPreview } from "./MarkdownPreview.tsx";

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
  /** Makes task list boxes in the preview clickable. */
  checklist?: ChecklistControl;
  /** Short text next to the title, e.g. "Checklist 3 of 7". */
  meta?: ReactNode;
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
  checklist,
  meta,
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

  // The text changed elsewhere (a checklist click, another tab, MCP): show it unless there are unsaved edits.
  useEffect(() => {
    if (value === saved.current) return;
    setDraft((current) => {
      if (current !== saved.current) return current;
      saved.current = value;
      return value;
    });
  }, [value]);

  return (
    <div className={styles.field}>
      <div className={styles.fieldHead}>
        <h2 className={styles.fieldTitle}>{title}</h2>
        {meta && <span className={styles.fieldMeta}>{meta}</span>}
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
        <MarkdownPreview source={draft} checklist={checklist} />
      ) : (
        <p className={styles.emptyText}>{emptyText}</p>
      )}
    </div>
  );
}
