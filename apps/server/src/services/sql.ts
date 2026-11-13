/** Small helpers for building queries. */

import type Database from "better-sqlite3";
import { type AnyColumn, type SQL, sql } from "drizzle-orm";
import { foldCase, foldDiacritics } from "./text.ts";

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

/**
 * SQL functions for Unicode-aware matching (SQLite's LIKE and lower() fold ASCII only):
 * fold_case(text) = foldCase, fold_diacritics(text) = foldDiacritics. Registered on every connection
 * by openDb; used in queries only, never in the schema, so the database file stays plain SQLite.
 */
export function registerTextFunctions(sqlite: Database.Database): void {
  const options = { deterministic: true };
  sqlite.function("fold_case", options, (text: unknown) =>
    typeof text === "string" ? foldCase(text) : text,
  );
  sqlite.function("fold_diacritics", options, (text: unknown) =>
    typeof text === "string" ? foldDiacritics(text) : text,
  );
}

/** "column contains text" without case (any script): fold_case(column) LIKE %foldCase(text)%. */
export const containsFolded = (column: SQL | AnyColumn, text: string): SQL =>
  sql`fold_case(${column}) LIKE ${`%${escapeLike(foldCase(text))}%`} ESCAPE '\\'`;
