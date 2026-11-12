import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExt } from "@codemirror/view";
import { type Ref, useEffect, useImperativeHandle, useRef } from "react";
import { errorMessage } from "../../lib/api.ts";
import { uploadAttachment } from "../../lib/attachments.ts";
import { useToast } from "../toast/ToastProvider.tsx";
import { Button } from "../ui.tsx";
import styles from "./Markdown.module.css";
import { filesOf, insertUploads, pendingUploads, type Upload } from "./uploads.ts";

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

/** CodeMirror 6 Markdown editor. The document is owned by CodeMirror; `value` only sets the start. */
export function MarkdownEditor({
  value,
  onChange,
  onBlur,
  onSubmit,
  autoFocus = false,
  label,
  placeholder = "Write notes in Markdown: lists, links, code, tables.",
  compact = false,
  upload = uploadAttachment,
  ref,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
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
            if (update.docChanged) latest.current.onChange(update.state.doc.toString());
          }),
          EditorView.domEventHandlers({
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
    // The editor is created once; later `value` changes come from the editor itself.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={styles.editorBox}>
      <div ref={host} className={styles.editor} data-compact={compact || undefined} />
      <div className={styles.editorBar}>
        <Button size="sm" variant="ghost" onClick={() => fileInput.current?.click()}>
          Attach file
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
    </div>
  );
}
