import { StateEffect, StateField } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/** What the editor needs to know about a stored file to link it. */
export interface UploadedFile {
  name: string;
  url: string;
  /** Images the app shows inline; everything else becomes a download link. */
  inline: boolean;
}

export type Upload = (file: File) => Promise<UploadedFile>;

interface Pending {
  id: number;
  from: number;
  to: number;
}

const addPending = StateEffect.define<Pending>();
const dropPending = StateEffect.define<number>();

/**
 * Where each upload placeholder sits. Positions follow every edit, so typing above a placeholder while
 * the file uploads still replaces the right text (and two pasted "image.png" never swap).
 */
export const pendingUploads = StateField.define<readonly Pending[]>({
  create: () => [],
  update(value, tr) {
    if (!tr.docChanged && tr.effects.length === 0) return value;
    const next = value.map((p) =>
      tr.docChanged ? { ...p, from: tr.changes.mapPos(p.from, 1), to: tr.changes.mapPos(p.to, -1) } : p,
    );
    const dropped = new Set<number>();
    for (const effect of tr.effects) {
      if (effect.is(addPending)) next.push(effect.value);
      if (effect.is(dropPending)) dropped.add(effect.value);
    }
    return dropped.size > 0 ? next.filter((p) => !dropped.has(p.id)) : next;
  },
});

export function placeholderText(file: { name: string }): string {
  return `![Uploading ${escapeLabel(file.name)}...]()`;
}

/** Markdown for a stored file: an image for inline types, a plain link for the rest. */
export function fileMarkdown(file: UploadedFile): string {
  const label = escapeLabel(file.name);
  return file.inline ? `![${label}](${file.url})` : `[${label}](${file.url})`;
}

function escapeLabel(name: string): string {
  return name.replace(/[[\]\\]/g, "\\$&");
}

let nextId = 1;

/**
 * Inserts one placeholder per file at `at` (default: the selection), uploads the files and swaps each
 * placeholder for its link as soon as that file is stored. A failed upload removes its placeholder and
 * calls onError.
 */
export async function insertUploads(
  view: EditorView,
  files: readonly File[],
  upload: Upload,
  onError: (file: File, error: unknown) => void,
  at?: number,
): Promise<void> {
  if (files.length === 0) return;
  const range = view.state.selection.main;
  const from = at ?? range.from;
  const to = at ?? range.to;
  const pieces = files.map((file) => ({ file, id: nextId++, text: placeholderText(file) }));
  // Several files land on their own lines; a single one goes right at the cursor.
  const joiner = files.length > 1 ? "\n" : "";
  let offset = from;
  const effects = pieces.map((piece, i) => {
    const start = offset + (i > 0 ? joiner.length : 0);
    offset = start + piece.text.length;
    return addPending.of({ id: piece.id, from: start, to: offset });
  });
  const insert = pieces.map((p) => p.text).join(joiner);
  view.dispatch({ changes: { from, to, insert }, effects, selection: { anchor: from + insert.length } });

  await Promise.all(
    pieces.map(async (piece) => {
      let replacement = "";
      try {
        replacement = fileMarkdown(await upload(piece.file));
      } catch (error) {
        onError(piece.file, error);
      }
      replace(view, piece.id, piece.text, replacement);
    }),
  );
}

function replace(view: EditorView, id: number, expected: string, text: string) {
  const pending = view.state.field(pendingUploads, false)?.find((p) => p.id === id);
  // The editor may be gone (page left) or the placeholder deleted by hand meanwhile.
  if (!pending) return;
  const current = view.state.sliceDoc(pending.from, pending.to);
  view.dispatch({
    changes: current === expected ? { from: pending.from, to: pending.to, insert: text } : undefined,
    effects: dropPending.of(id),
  });
}

/** Files from a paste or drop, or none when it is plain text. */
export function filesOf(data: DataTransfer | null): File[] {
  return data ? Array.from(data.files ?? []) : [];
}
