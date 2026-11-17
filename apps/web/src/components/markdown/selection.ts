import { EditorView } from "@codemirror/view";

/** Selected text inside a Markdown field, and where its end is on screen (viewport pixels). */
export interface TextSelection {
  text: string;
  /** The line box at the end of the selection. */
  rect: { left: number; top: number; bottom: number };
}

const elementOf = (node: Node): Element | null => (node instanceof Element ? node : node.parentElement);

/** The last line box of a range; the start of its element when the browser gives no boxes (tests). */
function endRect(range: Range): TextSelection["rect"] {
  const boxes = typeof range.getClientRects === "function" ? Array.from(range.getClientRects()) : [];
  const box = boxes.at(-1) ?? elementOf(range.endContainer)?.getBoundingClientRect();
  return box ? { left: box.left, top: box.top, bottom: box.bottom } : { left: 0, top: 0, bottom: 0 };
}

/**
 * The text selected inside `container` (the editor or the rendered preview), or null when nothing there
 * is selected. In the editor the text comes from the document, so lines scrolled out of view count too;
 * in the preview it is the rendered text, as the user sees it.
 */
export function readTextSelection(container: Element): TextSelection | null {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const common = elementOf(range.commonAncestorContainer);
  if (!common || !container.contains(common)) return null;
  const editor = common.closest<HTMLElement>(".cm-editor");
  const view = editor ? EditorView.findFromDOM(editor) : null;
  if (view) {
    const { from, to } = view.state.selection.main;
    const text = view.state.sliceDoc(from, to);
    const coords = view.coordsAtPos(to);
    if (!text.trim()) return null;
    return {
      text,
      rect: coords ? { left: coords.left, top: coords.top, bottom: coords.bottom } : endRect(range),
    };
  }
  const text = selection.toString();
  return text.trim() ? { text, rect: endRect(range) } : null;
}
