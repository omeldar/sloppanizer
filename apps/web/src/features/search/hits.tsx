import type { SearchHit, SearchKind } from "@organizer/shared";
import styles from "./Search.module.css";

export const KIND_NAMES: Record<SearchKind, string> = {
  todo: "Todos",
  note: "Notes",
  comment: "Comments",
  person: "People",
};

export const KIND_SINGULAR: Record<SearchKind, string> = {
  todo: "Todo",
  note: "Note",
  comment: "Comment",
  person: "Person",
};

export const KIND_ORDER: readonly SearchKind[] = ["todo", "note", "comment", "person"];

/** Where a hit opens: a comment opens its todo, scrolled to the comment. */
export function hitTarget(hit: SearchHit): { to: string; params: Record<string, string>; search?: object } {
  switch (hit.kind) {
    case "todo":
      return { to: "/todos/$id", params: { id: String(hit.id) } };
    case "note":
      return { to: "/notes/$id", params: { id: String(hit.id) } };
    case "comment":
      return { to: "/todos/$id", params: { id: String(hit.todoId ?? 0) }, search: { comment: hit.id } };
    case "person":
      return { to: "/people/$id", params: { id: String(hit.id) } };
  }
}

/**
 * Splits a snippet into plain and matched parts. Ranges from the server are clamped to the snippet,
 * sorted and merged, so a bad range can never cut text or repeat it.
 */
export function highlightParts(
  text: string,
  ranges: readonly (readonly [number, number])[],
): { text: string; hit: boolean }[] {
  const clean = ranges
    .map(([a, b]) => [Math.max(0, Math.min(a, text.length)), Math.max(0, Math.min(b, text.length))] as const)
    .filter(([a, b]) => b > a)
    .toSorted((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const [a, b] of clean) {
    const last = merged.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const parts: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [a, b] of merged) {
    if (a > at) parts.push({ text: text.slice(at, a), hit: false });
    parts.push({ text: text.slice(a, b), hit: true });
    at = b;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
}

/** Snippet text with the matches marked; plain React text, never HTML from the server. */
export function Highlighted({
  text,
  ranges,
}: {
  text: string;
  ranges: readonly (readonly [number, number])[];
}) {
  return (
    <>
      {highlightParts(text, ranges).map((part, i) =>
        part.hit ? (
          // oxlint-disable-next-line react/no-array-index-key -- parts have no identity besides their place
          <mark key={i} className={styles.mark}>
            {part.text}
          </mark>
        ) : (
          // oxlint-disable-next-line react/no-array-index-key -- parts have no identity besides their place
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}
