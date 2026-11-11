import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { useEffect, useRef } from "react";
import styles from "./Markdown.module.css";

interface Props {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  autoFocus?: boolean;
  label: string;
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
export function MarkdownEditor({ value, onChange, onBlur, autoFocus = false, label }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onChange, onBlur });
  useEffect(() => {
    callbacks.current = { onChange, onBlur };
  });

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          EditorView.lineWrapping,
          placeholder("Write notes in Markdown: lists, links, code, tables."),
          EditorView.contentAttributes.of({ "aria-label": label }),
          theme,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
          }),
          EditorView.domEventHandlers({ blur: () => callbacks.current.onBlur?.() }),
        ],
      }),
    });
    if (autoFocus) view.focus();
    return () => view.destroy();
    // The editor is created once; later `value` changes come from the editor itself.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={host} className={styles.editor} />;
}
