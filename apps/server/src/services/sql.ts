/** Small helpers for building queries. */

/** SQLite allows many bound parameters, but chunks keep big IN lists safe. */
const CHUNK = 500;

export function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/** Escapes LIKE wildcards; use with `ESCAPE '\\'`. */
export const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);

export interface SetChange<T> {
  /** Replaces the whole set when given. */
  set?: readonly T[] | undefined;
  add?: readonly T[] | undefined;
  remove?: readonly T[] | undefined;
}

/**
 * Applies a full-set or add/remove change to the current ids. Returns the next ids (current order
 * kept, new ones appended) and what was added and removed.
 */
export function diffIds(
  current: readonly number[],
  change: SetChange<number>,
): { next: number[]; added: number[]; removed: number[] } {
  let next: number[];
  if (change.set !== undefined) {
    next = [...new Set(change.set)];
  } else {
    const removed = new Set(change.remove ?? []);
    next = [...new Set([...current, ...(change.add ?? [])])].filter((id) => !removed.has(id));
  }
  return {
    next,
    added: next.filter((id) => !current.includes(id)),
    removed: current.filter((id) => !next.includes(id)),
  };
}
