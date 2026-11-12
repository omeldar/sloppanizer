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
