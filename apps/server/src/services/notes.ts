import {
  appendNoteText,
  type CreateNote,
  MAX_NOTE_CHARS,
  type Note,
  type NoteListQuery,
  type NotePage,
  type NoteSummary,
  type UpdateNote,
} from "@organizer/shared";
import { desc, eq, inArray, isNotNull, isNull, type SQL, sql } from "drizzle-orm";
import { notes } from "../db/schema.ts";
import { ApiError, notFound } from "../http/errors.ts";
import { plainText } from "./text.ts";
import { type Ctx, inTx, now, type Scoped } from "./context.ts";
import { insertOwnedRow, owned } from "./owned.ts";
import { assertProjectExists, projectRefs } from "./projects.ts";
import { indexNote, removeFromIndex } from "./search-index.ts";
import { chunks, containsFolded } from "./sql.ts";

export type NoteRow = typeof notes.$inferSelect;

const EXCERPT_LENGTH = 200;

export const noteExcerpt = (bodyMd: string): string => plainText(bodyMd).slice(0, EXCERPT_LENGTH);

function toNotes(sc: Scoped, rows: readonly NoteRow[]): Note[] {
  const projects = projectRefs(
    sc,
    rows.map((r) => r.projectId),
  );
  return rows.map((row) => ({
    id: row.id,
    projectId: row.projectId,
    project: row.projectId === null ? null : (projects.get(row.projectId) ?? null),
    title: row.title,
    bodyMd: row.bodyMd,
    pinnedAt: row.pinnedAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

const toSummary = ({ bodyMd, ...rest }: Note): NoteSummary => ({ ...rest, excerpt: noteExcerpt(bodyMd) });

/** Pinned notes first (newest pin first), then by last change. */
export function listNotes(sc: Scoped, query: NoteListQuery): NotePage {
  const conditions: (SQL | undefined)[] = [];
  if (query.projectId === "none") conditions.push(isNull(notes.projectId));
  else if (query.projectId !== undefined) conditions.push(eq(notes.projectId, query.projectId));
  if (query.pinned === true) conditions.push(isNotNull(notes.pinnedAt));
  if (query.pinned === false) conditions.push(isNull(notes.pinnedAt));
  if (query.q) conditions.push(containsFolded(notes.title, query.q));
  const where = owned(sc, notes, ...conditions);
  const rows = sc.db
    .select()
    .from(notes)
    .where(where)
    .orderBy(sql`${notes.pinnedAt} IS NULL`, desc(notes.pinnedAt), desc(notes.updatedAt), desc(notes.id))
    .limit(query.limit)
    .offset(query.offset)
    .all();
  const { n } = sc.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM ${notes} WHERE ${where}`);
  return { items: toNotes(sc, rows).map(toSummary), total: n, limit: query.limit, offset: query.offset };
}

function noteRow(sc: Scoped, id: number): NoteRow {
  const row = sc.db
    .select()
    .from(notes)
    .where(owned(sc, notes, eq(notes.id, id)))
    .get();
  if (!row) throw notFound("Note", id);
  return row;
}

/** Summaries of the account's notes with these ids, by id (unknown ids are left out). */
export function noteSummaries(sc: Scoped, ids: readonly number[]): Map<number, NoteSummary> {
  const out = new Map<number, NoteSummary>();
  for (const part of chunks(ids)) {
    const rows = sc.db
      .select()
      .from(notes)
      .where(owned(sc, notes, inArray(notes.id, part)))
      .all();
    for (const note of toNotes(sc, rows)) out.set(note.id, toSummary(note));
  }
  return out;
}

export function getNote(sc: Scoped, id: number): Note {
  return toNotes(sc, [noteRow(sc, id)])[0] as Note;
}

/** Writes a note inside the caller's transaction (and indexes it for search); returns its id. */
export function insertNote(sc: Scoped, actor: string, at: string, input: CreateNote): number {
  assertProjectExists(sc, input.projectId);
  const id = insertOwnedRow(sc, notes, {
    title: input.title,
    bodyMd: input.bodyMd ?? "",
    projectId: input.projectId ?? null,
    pinnedAt: input.pinned ? at : null,
    createdBy: actor,
    createdAt: at,
    updatedAt: at,
  });
  indexNote(sc, id);
  return id;
}

export function createNote(ctx: Ctx, actor: string, input: CreateNote): Note {
  return ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    return getNote(sc, insertNote(sc, actor, now(ctx), input));
  });
}

/** Changes a note; pinned true keeps an earlier pin time, false unpins. A no-op keeps updatedAt. */
export function updateNote(ctx: Ctx, id: number, input: UpdateNote): Note {
  return ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    const current = noteRow(sc, id);
    const at = now(ctx);
    const patch: Partial<NoteRow> = {};
    if (input.title !== undefined && input.title !== current.title) patch.title = input.title;
    if (input.bodyMd !== undefined && input.bodyMd !== current.bodyMd) patch.bodyMd = input.bodyMd;
    if (input.appendMd !== undefined) {
      // Appended inside the transaction: an autosave of the web editor in between is not overwritten.
      patch.bodyMd = appendNoteText(current.bodyMd, input.appendMd);
      if (patch.bodyMd.length > MAX_NOTE_CHARS) {
        throw new ApiError("validation_failed", `Keep the note under ${MAX_NOTE_CHARS} characters.`);
      }
    }
    if (input.projectId !== undefined && input.projectId !== current.projectId) {
      assertProjectExists(sc, input.projectId);
      patch.projectId = input.projectId;
    }
    if (input.pinned === true && current.pinnedAt === null) patch.pinnedAt = at;
    if (input.pinned === false && current.pinnedAt !== null) patch.pinnedAt = null;
    if (Object.keys(patch).length === 0) return toNotes(sc, [current])[0] as Note;
    const row = sc.db
      .update(notes)
      .set({ ...patch, updatedAt: at })
      .where(owned(sc, notes, eq(notes.id, id)))
      .returning()
      .get() as NoteRow;
    if (patch.title !== undefined || patch.bodyMd !== undefined) indexNote(sc, id);
    return toNotes(sc, [row])[0] as Note;
  });
}

export function deleteNote(ctx: Ctx, id: number): void {
  ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    const result = sc.db
      .delete(notes)
      .where(owned(sc, notes, eq(notes.id, id)))
      .run();
    if (result.changes === 0) throw notFound("Note", id);
    removeFromIndex(sc, "note", id);
  });
}
