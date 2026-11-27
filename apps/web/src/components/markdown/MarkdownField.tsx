import { type ReactNode, type Ref, useState } from "react";
import { MarkdownEditor, type MarkdownEditorHandle } from "./MarkdownEditor.tsx";
import styles from "./Markdown.module.css";
import { replaceLinkTarget } from "./drawingLinks.ts";
import { type ChecklistControl, MarkdownPreview } from "./MarkdownPreview.tsx";
import { useAutosave } from "./useAutosave.ts";

export { SAVE_DELAY_MS } from "./useAutosave.ts";
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
 * A titled Markdown block with Write and Preview that saves itself: after a short pause, on blur, when
 * switching to Preview and when it goes away. Text changed elsewhere shows up unless there are unsaved
 * edits. Used for todo descriptions, notes and person notes.
 */
export function MarkdownField({
  title,
  value,
  save,
  emptyText,
  startWriting = false,
  autoFocus = false,
  editorRef,
  checklist,
  meta,
}: Props) {
  const [editing, setEditing] = useState(startWriting || value === "");
  const { draft, state, change, flush } = useAutosave(value, save);

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
              flush();
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
          followValue
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- passes the caller's choice on to the editor
          autoFocus={autoFocus}
          onChange={change}
          onBlur={flush}
        />
      ) : draft.trim() ? (
        <MarkdownPreview
          source={draft}
          checklist={checklist}
          onReplaceLink={(from, to) => {
            change(replaceLinkTarget(draft, from, to));
            flush();
          }}
        />
      ) : (
        <p className={styles.emptyText}>{emptyText}</p>
      )}
    </div>
  );
}
