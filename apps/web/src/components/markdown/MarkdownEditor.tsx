import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { Annotation, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExt } from "@codemirror/view";
import { lazy, type Ref, Suspense, useEffect, useImperativeHandle, useRef, useState } from "react";
import { errorMessage } from "../../lib/api.ts";
import { uploadAttachment } from "../../lib/attachments.ts";
import { useToast } from "../toast/ToastProvider.tsx";
import { Button } from "../ui.tsx";
import styles from "./Markdown.module.css";
import { drawingMarkdown } from "./drawingLinks.ts";
import { filesOf, insertAtCursor, insertUploads, pendingUploads, type Upload } from "./uploads.ts";

// The drawing dialog loads on first use: the editor chunk stays as it was.
const DrawDialog = lazy(() => import("../../features/drawings/DrawDialog.tsx"));

export interface MarkdownEditorHandle {
  focus: () => void;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  /** ctrl+enter (cmd+enter), e.g. to send a comment. */
  onSubmit?: () => void;
  autoFocus?: boolean;
  label: string;
  placeholder?: string;
  /** Smaller start height for comment boxes. */
  compact?: boolean;
  /**
   * Take in later `value` changes that differ from the editor's text (an autosaving field showing a change
   * made elsewhere). Without it, `value` only sets the start and the editor owns its text.
   */
  followValue?: boolean;
  /** Stores a pasted, dropped or picked file (default: the attachments API). */
  upload?: Upload;
  ref?: Ref<MarkdownEditorHandle>;
}

const theme = EditorView.theme({
  "&": { backgroundColor: "var(--sunken)", color: "var(--text)", fontSize: "13.5px" },
  "&.cm-focused": { outline: "2px solid var(--amber)", outlineOffset: "-1px" },
  ".cm-content": {
    fontFamily: "var(--font-mono)",
    padding: "12px 0",
    caretColor: "var(--amber)",
    lineHeight: "1.6",
  },
  ".cm-line": { padding: "0 14px" },
  ".cm-cursor": { borderLeftColor: "var(--amber)", borderLeftWidth: "2px" },
  ".cm-placeholder": { color: "var(--text-3)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--amber-tint)",
  },
});

/** Marks a change that came in through `value`, so it is not reported back through onChange. */
const fromOutside = Annotation.define<boolean>();

/** The smallest single change that turns `from` into `to`, so the cursor outside it stays put. */
export function replaceChange(from: string, to: string): { from: number; to: number; insert: string } {
  const max = Math.min(from.length, to.length);
  let start = 0;
  while (start < max && from[start] === to[start]) start += 1;
  let end = 0;
  while (end < max - start && from[from.length - 1 - end] === to[to.length - 1 - end]) end += 1;
  return { from: start, to: from.length - end, insert: to.slice(start, to.length - end) };
}

/** CodeMirror 6 Markdown editor. The document is owned by CodeMirror; `value` sets the start (see followValue). */
export function MarkdownEditor({
  value,
  onChange,
  onBlur,
  onSubmit,
  autoFocus = false,
  label,
  placeholder = "Write notes in Markdown: lists, links, code, tables.",
  compact = false,
  followValue = false,
  upload = uploadAttachment,
  ref,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [drawing, setDrawing] = useState(false);
  /** The text was clicked or focused once: its cursor is where the user wants things to go. */
  const placed = useRef(false);
  const toast = useToast();
  const latest = useRef({ onChange, onBlur, onSubmit, upload, toast });
  useEffect(() => {
    latest.current = { onChange, onBlur, onSubmit, upload, toast };
  });

  useImperativeHandle(ref, () => ({ focus: () => viewRef.current?.focus() }), []);

  const attach = (files: File[], at?: number) => {
    const view = viewRef.current;
    if (!view || files.length === 0) return false;
    void insertUploads(
      view,
      files,
      latest.current.upload,
      (file, error) =>
        latest.current.toast.show({
          tone: "error",
          message: `Could not attach ${file.name}. ${errorMessage(error)}`,
        }),
      at,
    );
    return true;
  };

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => {
                if (!latest.current.onSubmit) return false;
                latest.current.onSubmit();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          markdown(),
          EditorView.lineWrapping,
          placeholderExt(placeholder),
          EditorView.contentAttributes.of({ "aria-label": label }),
          theme,
          pendingUploads,
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.some((tr) => tr.annotation(fromOutside))) {
              latest.current.onChange(update.state.doc.toString());
            }
          }),
          EditorView.domEventHandlers({
            focus: () => {
              placed.current = true;
            },
            blur: () => latest.current.onBlur?.(),
            paste: (event) => {
              const files = filesOf(event.clipboardData);
              if (!attach(files)) return false;
              event.preventDefault();
              return true;
            },
            drop: (event, editor) => {
              const files = filesOf(event.dataTransfer);
              const at = editor.posAtCoords({ x: event.clientX, y: event.clientY }) ?? undefined;
              if (!attach(files, at)) return false;
              event.preventDefault();
              return true;
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    if (autoFocus) view.focus();
    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // The editor is created once; later `value` changes come from the editor itself or the effect below.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!followValue || !view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    // Not undoable: undo would bring back the old text and save it over the new one.
    view.dispatch({
      changes: replaceChange(current, value),
      annotations: [fromOutside.of(true), Transaction.addToHistory.of(false)],
    });
  }, [followValue, value]);

  return (
    <div className={styles.editorBox}>
      <div ref={host} className={styles.editor} data-compact={compact || undefined} />
      <div className={styles.editorBar}>
        <Button size="sm" variant="ghost" onClick={() => fileInput.current?.click()}>
          Attach file
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDrawing(true)}>
          Draw
        </Button>
        <span className={styles.editorHint}>or paste and drop files into the text</span>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          aria-label="Attach file"
          onChange={(event) => {
            attach(Array.from(event.target.files ?? []));
            event.target.value = "";
            viewRef.current?.focus();
          }}
        />
      </div>
      {drawing && (
        <Suspense fallback={null}>
          <DrawDialog
            open
            onOpenChange={(open) => {
              if (open) return;
              setDrawing(false);
              viewRef.current?.focus();
            }}
            upload={(file) => latest.current.upload(file)}
            onDone={({ url }) => {
              const view = viewRef.current;
              if (!view) return;
              // Never clicked into: the drawing goes at the end, not before the first word.
              if (!placed.current) view.dispatch({ selection: { anchor: view.state.doc.length } });
              insertAtCursor(view, drawingMarkdown(url));
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
