import { useEffect, useRef } from "react";

/**
 * The id one step (`delta`) from `selectedId` in `ids`, stopping at the ends. With nothing selected (or
 * the selection gone from the list), j starts at the first row and k at the last. null for an empty list.
 */
export function stepCursor(ids: readonly number[], selectedId: number | null, delta: number): number | null {
  if (ids.length === 0) return null;
  const index = selectedId === null ? -1 : ids.indexOf(selectedId);
  const next = index === -1 ? (delta > 0 ? 0 : ids.length - 1) : index + delta;
  return ids[Math.max(0, Math.min(ids.length - 1, next))] ?? null;
}

/** A ref for a list row that scrolls the row into view when it becomes the selected one. */
export function useScrollIntoView<T extends HTMLElement>(selected: boolean) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  return ref;
}
