import {
  SEARCH_KINDS,
  type SearchHit,
  type SearchKind,
  type SearchQuery,
  type SearchResult,
  toLocalDateTime,
  type TodoStatus,
} from "@organizer/shared";
import { inArray, type SQL, sql } from "drizzle-orm";
import { comments, notes, people, todos } from "../db/schema.ts";
import type { Ctx, Tx } from "./context.ts";
import { foldChars, plainText } from "./text.ts";
import { projectRefs } from "./projects.ts";
import { escapeLike } from "./sql.ts";

/** Trigram tokens need 3 characters; shorter terms fall back to LIKE. */
const MIN_FTS_TERM = 3;
const SNIPPET_LENGTH = 120;
/** Characters of context before the first match. */
const SNIPPET_LEAD = 40;
const ELLIPSIS = "...";

interface IndexRow {
  refId: number;
  todoId: number | null;
  title: string;
  body: string;
}

/** One FTS5 phrase per term: quoted, inner quotes doubled, so no query syntax gets through. */
export const ftsPhrase = (term: string): string => `"${term.replaceAll('"', '""')}"`;

/** Character ranges where any term occurs (case and diacritics folded), merged and sorted. */
export function findRanges(text: string, terms: readonly string[]): [number, number][] {
  const haystack = foldChars(text);
  const ranges: [number, number][] = [];
  for (const term of terms) {
    const needle = foldChars(term);
    if (needle.length === 0) continue;
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
      ranges.push([at, at + needle.length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

/** About 120 characters around the first match, with the match ranges inside the snippet. */
export function makeSnippet(
  text: string,
  terms: readonly string[],
): Pick<SearchHit, "snippet" | "highlights"> {
  const flat = text.replace(/\s+/g, " ").trim();
  const first = findRanges(flat, terms)[0];
  let start = first ? Math.max(0, first[0] - SNIPPET_LEAD) : 0;
  if (start > 0) {
    // Start at a word when one begins close by.
    const space = flat.indexOf(" ", start);
    if (space !== -1 && first && space < first[0] && space - start < 15) start = space + 1;
  }
  const end = Math.min(flat.length, start + SNIPPET_LENGTH);
  const snippet = `${start > 0 ? ELLIPSIS : ""}${flat.slice(start, end)}${end < flat.length ? ELLIPSIS : ""}`;
  const offset = start > 0 ? ELLIPSIS.length : 0;
  const bodyEnd = offset + (end - start);
  const highlights = findRanges(snippet, terms)
    .map(([a, b]): [number, number] => [Math.max(a, offset), Math.min(b, bodyEnd)])
    .filter(([a, b]) => a < b);
  return { snippet, highlights };
}

/** WHERE parts for the terms: FTS phrases ANDed, plus a LIKE per short term. */
function termConditions(terms: readonly string[]): { match: string | null; likes: SQL[] } {
  const long = terms.filter((t) => [...t].length >= MIN_FTS_TERM);
  const short = terms.filter((t) => [...t].length < MIN_FTS_TERM);
  return {
    match: long.length > 0 ? long.map(ftsPhrase).join(" AND ") : null,
    likes: short.map((t) => sql`(title || ' ' || body) LIKE ${`%${escapeLike(t)}%`} ESCAPE '\\'`),
  };
}

function whereFor(kind: SearchKind, terms: readonly string[]): SQL {
  const { match, likes } = termConditions(terms);
  const parts = [sql`kind = ${kind}`, ...likes];
  if (match !== null) parts.unshift(sql`search_fts MATCH ${match}`);
  return sql.join(parts, sql` AND `);
}

function searchKind(db: Tx, kind: SearchKind, terms: readonly string[], limit: number): IndexRow[] {
  const { match } = termConditions(terms);
  // bm25 weights: kind, ref_id, todo_id (unindexed), title 5, body 1. Ties and LIKE-only: newest id first.
  const order = match !== null ? sql`bm25(search_fts, 0, 0, 0, 5, 1), ref_id DESC` : sql`ref_id DESC`;
  return db.all<IndexRow>(sql`
    SELECT ref_id AS refId, todo_id AS todoId, title, body FROM search_fts
    WHERE ${whereFor(kind, terms)} ORDER BY ${order} LIMIT ${limit}`);
}

function countKind(db: Tx, kind: SearchKind, terms: readonly string[]): number {
  return db.get<{ n: number }>(sql`SELECT count(*) AS n FROM search_fts WHERE ${whereFor(kind, terms)}`).n;
}

const idsOf = (rows: readonly IndexRow[]) => rows.map((r) => r.refId);

/** Turns index rows into hits, reading the details each kind shows from its table. */
function toHits(
  ctx: Pick<Ctx, "db" | "timeZone">,
  kind: SearchKind,
  rows: IndexRow[],
  terms: string[],
): SearchHit[] {
  const { db } = ctx;
  if (rows.length === 0) return [];
  const base = (row: IndexRow, title: string, text: string) => ({
    kind,
    id: row.refId,
    title,
    ...makeSnippet(text, terms),
    todoId: null as number | null,
    status: null as TodoStatus | null,
    subtitle: null as string | null,
  });
  switch (kind) {
    case "todo": {
      const status = new Map(
        db
          .select({ id: todos.id, status: todos.status })
          .from(todos)
          .where(inArray(todos.id, idsOf(rows)))
          .all()
          .map((t) => [t.id, t.status]),
      );
      return rows.map((row) => ({
        ...base(row, row.title, plainText(row.body)),
        todoId: row.refId,
        status: status.get(row.refId) ?? null,
      }));
    }
    case "note": {
      const projectOf = new Map(
        db
          .select({ id: notes.id, projectId: notes.projectId })
          .from(notes)
          .where(inArray(notes.id, idsOf(rows)))
          .all()
          .map((n) => [n.id, n.projectId]),
      );
      const projects = projectRefs(db, [...projectOf.values()]);
      return rows.map((row) => {
        const projectId = projectOf.get(row.refId) ?? null;
        return {
          ...base(row, row.title, plainText(row.body)),
          subtitle: projectId === null ? null : (projects.get(projectId)?.name ?? null),
        };
      });
    }
    case "comment": {
      const meta = new Map(
        db
          .select({
            id: comments.id,
            actor: comments.actor,
            createdAt: comments.createdAt,
            title: todos.title,
          })
          .from(comments)
          .innerJoin(todos, sql`${todos.id} = ${comments.todoId}`)
          .where(inArray(comments.id, idsOf(rows)))
          .all()
          .map((c) => [c.id, c]),
      );
      return rows.map((row) => {
        const m = meta.get(row.refId);
        return {
          ...base(row, m?.title ?? "", plainText(row.body)),
          todoId: row.todoId,
          subtitle: m ? `${m.actor}, ${toLocalDateTime(m.createdAt, ctx.timeZone)}` : null,
        };
      });
    }
    case "person": {
      const teams = new Map(
        db
          .select({ id: people.id, team: people.team })
          .from(people)
          .where(inArray(people.id, idsOf(rows)))
          .all()
          .map((p) => [p.id, p.team]),
      );
      return rows.map((row) => {
        // Body lines: team, email, note, then one topic per line.
        const [, , , ...topics] = row.body.split("\n");
        const subtitle = [teams.get(row.refId) ?? "", topics.filter(Boolean).join(", ")]
          .filter(Boolean)
          .join(" | ");
        return { ...base(row, row.title, row.body), subtitle: subtitle || null };
      });
    }
  }
}

/** "#123" or "123": that todo, if it exists. */
function todoByNumber(db: Tx, q: string): IndexRow | null {
  const match = /^#?(\d{1,15})$/.exec(q);
  if (!match) return null;
  const id = Number(match[1]);
  return (
    db.get<IndexRow | undefined>(
      sql`SELECT ref_id AS refId, todo_id AS todoId, title, body FROM search_fts WHERE rowid = ${id * 4}`,
    ) ?? null
  );
}

/**
 * Search over todos, notes, comments and people. Terms are ANDed; ranking by bm25 (title weight 5),
 * then newest. Counts per kind ignore the limit.
 */
export function search(ctx: Pick<Ctx, "db" | "timeZone">, query: SearchQuery): SearchResult {
  const { db } = ctx;
  const terms = query.q.split(/\s+/).filter((t) => t.length > 0);
  const counts = { todo: 0, note: 0, comment: 0, person: 0 };
  const items: SearchHit[] = [];
  for (const kind of SEARCH_KINDS) {
    if (!query.kinds.includes(kind)) continue;
    let rows = searchKind(db, kind, terms, query.limit);
    counts[kind] = countKind(db, kind, terms);
    if (kind === "todo") {
      const byNumber = todoByNumber(db, query.q);
      if (byNumber) {
        const already = rows.some((r) => r.refId === byNumber.refId);
        if (!already) counts.todo += 1;
        rows = [byNumber, ...rows.filter((r) => r.refId !== byNumber.refId)].slice(0, query.limit);
      }
    }
    items.push(...toHits(ctx, kind, rows, terms));
  }
  return { q: query.q, items, counts };
}
