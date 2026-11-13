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
import { and, desc, eq, isNotNull, isNull, type SQL, sql } from "drizzle-orm";
import { notes } from "../db/schema.ts";
import { ApiError, notFound } from "../http/errors.ts";
import { plainText } from "./text.ts";
import { type Ctx, now, type Tx } from "./context.ts";
import { assertProjectExists, projectRefs } from "./projects.ts";
import { indexNote, removeFromIndex } from "./search-index.ts";
import { containsFolded } from "./sql.ts";

export type NoteRow = typeof notes.$inferSelect;

const EXCERPT_LENGTH = 200;

export const noteExcerpt = (bodyMd: string): string => plainText(bodyMd).slice(0, EXCERPT_LENGTH);

function toNotes(db: Tx, rows: readonly NoteRow[]): Note[] {
  const projects = projectRefs(
    db,
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
export function listNotes(db: Tx, query: NoteListQuery): NotePage {
  const conditions: (SQL | undefined)[] = [];
  if (query.projectId === "none") conditions.push(isNull(notes.projectId));
  else if (query.projectId !== undefined) conditions.push(eq(notes.projectId, query.projectId));
  if (query.pinned === true) conditions.push(isNotNull(notes.pinnedAt));
  if (query.pinned === false) conditions.push(isNull(notes.pinnedAt));
  if (query.q) conditions.push(containsFolded(notes.title, query.q));
  const where = and(...conditions);
  const rows = db
    .select()
    .from(notes)
    .where(where)
    .orderBy(sql`${notes.pinnedAt} IS NULL`, desc(notes.pinnedAt), desc(notes.updatedAt), desc(notes.id))
    .limit(query.limit)
    .offset(query.offset)
    .all();
  const { n } = db.get<{ n: number }>(
    sql`SELECT count(*) AS n FROM ${notes} ${where ? sql`WHERE ${where}` : sql``}`,
  );
  return { items: toNotes(db, rows).map(toSummary), total: n, limit: query.limit, offset: query.offset };
}

function noteRow(db: Tx, id: number): NoteRow {
  const row = db.select().from(notes).where(eq(notes.id, id)).get();
  if (!row) throw notFound("Note", id);
  return row;
}

export function getNote(db: Tx, id: number): Note {
  return toNotes(db, [noteRow(db, id)])[0] as Note;
}

export function createNote(ctx: Ctx, actor: string, input: CreateNote): Note {
  return ctx.db.transaction((tx) => {
    assertProjectExists(tx, input.projectId);
    const at = now(ctx);
    const row = tx
      .insert(notes)
      .values({
        title: input.title,
        bodyMd: input.bodyMd ?? "",
        projectId: input.projectId ?? null,
        pinnedAt: input.pinned ? at : null,
        createdBy: actor,
        createdAt: at,
        updatedAt: at,
      })
      .returning()
      .get();
    indexNote(tx, row.id);
    return toNotes(tx, [row])[0] as Note;
  });
}

/** Changes a note; pinned true keeps an earlier pin time, false unpins. A no-op keeps updatedAt. */
export function updateNote(ctx: Ctx, id: number, input: UpdateNote): Note {
  return ctx.db.transaction((tx) => {
    const current = noteRow(tx, id);
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
      assertProjectExists(tx, input.projectId);
      patch.projectId = input.projectId;
    }
    if (input.pinned === true && current.pinnedAt === null) patch.pinnedAt = at;
    if (input.pinned === false && current.pinnedAt !== null) patch.pinnedAt = null;
    if (Object.keys(patch).length === 0) return toNotes(tx, [current])[0] as Note;
    const row = tx
      .update(notes)
      .set({ ...patch, updatedAt: at })
      .where(eq(notes.id, id))
      .returning()
      .get() as NoteRow;
    if (patch.title !== undefined || patch.bodyMd !== undefined) indexNote(tx, id);
    return toNotes(tx, [row])[0] as Note;
  });
}

export function deleteNote(ctx: Ctx, id: number): void {
  ctx.db.transaction((tx) => {
    const result = tx.delete(notes).where(eq(notes.id, id)).run();
    if (result.changes === 0) throw notFound("Note", id);
    removeFromIndex(tx, "note", id);
  });
}
