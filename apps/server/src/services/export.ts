import { createReadStream, statSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { PassThrough, type Readable } from "node:stream";
import {
  describeRecurrence,
  formatDuration,
  INLINE_IMAGE_TYPES,
  toLocalDate,
  toLocalDateTime,
  todoDurationMs,
} from "@organizer/shared";
import { asc } from "drizzle-orm";
import { strToU8, Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { stringify } from "yaml";
import { schemaVersion } from "../db/index.ts";
import { todos } from "../db/schema.ts";
import type { Ctx } from "./context.ts";
import { slugify } from "./projects.ts";
import { LOCAL_SETTING_KEYS, setSetting } from "./settings.ts";
import { LAST_EXPORT_AT } from "./stats.ts";
import { compareNames } from "./text.ts";
import { hydrate } from "./todos.ts";

export const EXPORT_FORMAT = 3;

/** Tables in the export, in restore order (parents before children). Never api_tokens, search_fts or the secret. */
export const EXPORT_TABLES = [
  "projects",
  "labels",
  "people",
  "topics",
  "person_tags",
  "person_topics",
  "person_tag_links",
  "todos",
  "todo_labels",
  "todo_people",
  "todo_links",
  "notes",
  "comments",
  "attachments",
  "events",
  "settings",
] as const;

const README = `# organizer export

This archive is a complete copy of your organizer data (API tokens, the secret and settings of
this device are left out). Export format 3.

- manifest.json: app, export format, time of export, app and schema version, row counts per table,
  the attachments (count, bytes, ids of files that were missing on disk) and the id sequences of
  todos and attachments (so a restore never gives out an old id again).
- data.json: every row of every table with its original id (column names as in the database).
  This is the file a restore reads. Text is kept exactly as stored, links included.
- attachments/: every uploaded file as <id>-<name>.
- todos/: one Markdown file per todo (NNNN-title.md): YAML front matter with the main fields
  (also parent, subtasks, links, repeat, previous and next occurrence), then the description and
  the comments.
- notes/: one Markdown file per note (NNNN-title.md): front matter, then the note.
- people/: one Markdown file per person (NNNN-first-last.md): team, email, topics, tags, the todos
  they requested or are a contact for, then the notes about them.

In the Markdown files, links to uploaded files point into attachments/, so images show up in any
Markdown viewer. The Markdown files are for reading and searching; a restore does not need them.

Restore: in organizer open Settings, Restore, and pick this zip. It reads data.json and
attachments/ and replaces all data, after saving a safety copy of the current data. Formats 1 to 3
can be restored.
`;

// ---------- Markdown helpers ----------

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function localClock(date: Date, timeZone: string): { hour: number; minute: number; second: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<string, number>;
  return { hour: parts.hour ?? 0, minute: parts.minute ?? 0, second: parts.second ?? 0 };
}

/** Local wall-clock stamp for the file name, e.g. 20261111-153000. */
export function fileStamp(date: Date, timeZone: string): string {
  const { hour, minute, second } = localClock(date, timeZone);
  return `${toLocalDate(date, timeZone).replaceAll("-", "")}-${pad(hour)}${pad(minute)}${pad(second)}`;
}

/** `dir/0042-some-title.md`: zero-padded id plus a short slug, so files sort by id. */
export function markdownPath(dir: string, id: number, title: string, fallback: string): string {
  const slug = slugify(title, fallback).slice(0, 50).replace(/-+$/, "");
  return `${dir}/${String(id).padStart(4, "0")}-${slug}.md`;
}

/** YAML front matter, a blank line, then the body ending in exactly one newline (nothing for an empty body). */
export function markdownDocument(frontMatter: Record<string, unknown>, body: string): string {
  const text = body.replace(/\s+$/, "");
  return `---\n${stringify(frontMatter)}---\n\n${text === "" ? "" : `${text}\n`}`;
}

/** File name of an attachment inside attachments/ (the stored name is sanitized already; this keeps it so). */
export function attachmentFileName(attachment: { id: number; name: string }): string {
  return `${attachment.id}-${attachment.name.replace(/[^A-Za-z0-9._-]/g, "-") || "file"}`;
}

// `/api/v1/attachments/<id>` with an optional `/<name>` and an optional origin in front of it.
const ATTACHMENT_LINK =
  /(?:https?:\/\/[^\s/()<>"']+)?\/api\/v1\/attachments\/(\d+)(?:\/[^\s()<>"']*)?(?=[\s()<>"']|$)/g;

/**
 * Points links to uploaded files at the copies in attachments/ (relative to todos/, notes/ or people/).
 * Links to ids that are not in `files` stay as they are. Only for the Markdown files: data.json keeps the raw text.
 */
export function rewriteAttachmentLinks(markdown: string, files: ReadonlyMap<number, string>): string {
  return markdown.replace(ATTACHMENT_LINK, (link, id: string) => {
    const file = files.get(Number(id));
    return file === undefined ? link : `../attachments/${file}`;
  });
}

export interface ExportComment {
  actor: string;
  bodyMd: string;
  createdAt: string;
}

/** "## Comments" with one "### actor, local date time" block per comment, oldest first; "" without comments. */
export function commentsSection(comments: readonly ExportComment[], timeZone: string): string {
  if (comments.length === 0) return "";
  const blocks = comments.map(
    (c) => `### ${c.actor}, ${toLocalDateTime(c.createdAt, timeZone)}\n\n${c.bodyMd.replace(/\s+$/, "")}`,
  );
  return `## Comments\n\n${blocks.join("\n\n")}`;
}

// ---------- rows as stored (data.json column names) ----------

interface PersonRow {
  id: number;
  first_name: string;
  last_name: string;
  note: string;
  team: string;
  email: string;
  notes_md: string;
  created_at: string;
}
interface NamedRow {
  id: number;
  name: string;
}
interface NoteRow {
  id: number;
  project_id: number | null;
  title: string;
  body_md: string;
  pinned_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}
interface CommentRow {
  id: number;
  todo_id: number;
  actor: string;
  body_md: string;
  created_at: string;
}
interface AttachmentRow {
  id: number;
  name: string;
  mime_type: string;
  size: number;
}

/** Files that are compressed already; zipping them again only costs time. */
const STORED_TYPES = new Set<string>([...INLINE_IMAGE_TYPES, "application/pdf"]);

function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const list = map.get(key(row));
    if (list) list.push(row);
    else map.set(key(row), [row]);
  }
  return map;
}

export interface ExportOptions {
  /** Where the uploaded files live (<data dir>/attachments). */
  attachmentsDir: string;
  appVersion: string;
  /** false: leave lastExportAt alone (the safety copy before a restore). Default true. */
  recordExport?: boolean;
}

/** One file of the zip: bytes built in memory, or an uploaded file read as a stream. */
type ZipEntry = { path: string; stored: boolean } & ({ content: Uint8Array } | { file: string });

export interface ExportResult {
  fileName: string;
  /** The zip, produced while it is read; errors (a file gone missing) destroy the stream. */
  stream: Readable;
}

/** Reads the sequences of the AUTOINCREMENT tables, so a restore never hands out an id again. */
function sequences(ctx: Ctx): { todos: number; attachments: number } {
  const rows = ctx.db.$client.prepare("SELECT name, seq FROM sqlite_sequence").all() as {
    name: string;
    seq: number;
  }[];
  const seq = (name: string) => rows.find((r) => r.name === name)?.seq ?? 0;
  return { todos: seq("todos"), attachments: seq("attachments") };
}

/**
 * Builds the export (format 3) and stores settings.lastExportAt. The database is read in one
 * snapshot right away; the zip is streamed, and uploaded files are read from disk while it streams,
 * so memory stays small even with many files.
 */
export function buildExport(ctx: Ctx, options: ExportOptions): ExportResult {
  const exportedAt = ctx.clock();
  const exportedAtIso = exportedAt.toISOString();
  const tz = ctx.timeZone;
  // Store the export time first so the copy includes it, like a backup taken right now.
  if (options.recordExport !== false) setSetting(ctx.db, LAST_EXPORT_AT, exportedAtIso);

  const sqlite = ctx.db.$client;
  const data: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  const readAll = sqlite.transaction(() => {
    for (const table of EXPORT_TABLES) {
      const rows =
        table === "settings"
          ? sqlite
              .prepare(
                `SELECT * FROM settings WHERE key NOT IN (${LOCAL_SETTING_KEYS.map(() => "?").join(", ")}) ORDER BY rowid`,
              )
              .all(...LOCAL_SETTING_KEYS)
          : sqlite.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
      data[table] = rows;
      counts[table] = rows.length;
    }
    return {
      todos: hydrate(ctx.db, ctx.db.select().from(todos).orderBy(asc(todos.id)).all()),
      sequences: sequences(ctx),
    };
  });
  const snapshot = readAll();
  const allTodos = snapshot.todos;
  const rows = <T>(table: (typeof EXPORT_TABLES)[number]) => (data[table] ?? []) as T[];

  // Attachments first: the Markdown links point at the files that made it into the zip.
  const entries: ZipEntry[] = [];
  const attachmentFiles = new Map<number, string>();
  const missing: number[] = [];
  let bytes = 0;
  for (const attachment of rows<AttachmentRow>("attachments")) {
    const file = join(options.attachmentsDir, String(attachment.id));
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      missing.push(attachment.id);
      continue;
    }
    const name = attachmentFileName(attachment);
    attachmentFiles.set(attachment.id, name);
    bytes += size;
    entries.push({ path: `attachments/${name}`, file, stored: STORED_TYPES.has(attachment.mime_type) });
  }
  const text = (path: string, content: string) =>
    entries.push({ path, content: strToU8(content), stored: false });
  const md = (body: string) => rewriteAttachmentLinks(body, attachmentFiles);

  const commentsByTodo = groupBy(
    rows<CommentRow>("comments").toSorted((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id),
    (c) => c.todo_id,
  );
  const childrenOf = groupBy(
    allTodos.filter((t) => t.parentId !== null),
    (t) => t.parentId as number,
  );
  for (const todo of allTodos) {
    const duration = todoDurationMs(todo.createdAt, todo.doneAt);
    const comments = commentsSection(
      (commentsByTodo.get(todo.id) ?? []).map((c) => ({
        actor: c.actor,
        bodyMd: md(c.body_md),
        createdAt: c.created_at,
      })),
      tz,
    );
    const body = [md(todo.descriptionMd).replace(/\s+$/, ""), comments].filter((x) => x !== "").join("\n\n");
    text(
      markdownPath("todos", todo.id, todo.title, "todo"),
      markdownDocument(
        {
          id: todo.id,
          title: todo.title,
          status: todo.status,
          project: todo.project?.slug ?? null,
          labels: todo.labels.map((l) => l.name),
          requested_by: todo.requestedBy.map((p) => p.displayName),
          contacts: todo.contacts.map((p) => p.displayName),
          due: todo.dueOn,
          planned: todo.plannedOn,
          created: todo.createdAt,
          done: todo.doneAt,
          took: todo.status === "done" && duration !== null ? formatDuration(duration) : null,
          parent: todo.parent?.id ?? null,
          subtasks: (childrenOf.get(todo.id) ?? []).map((c) => c.id),
          blocks: todo.links.blocks.map((t) => t.id),
          blocked_by: todo.links.blockedBy.map((t) => t.id),
          relates_to: todo.links.relatesTo.map((t) => t.id),
          repeat: todo.recurrence === null ? null : describeRecurrence(todo.recurrence),
          previous: todo.previousOccurrenceId,
          next: todo.nextOccurrence?.id ?? null,
        },
        body,
      ),
    );
  }

  const projectSlugs = new Map(rows<{ id: number; slug: string }>("projects").map((p) => [p.id, p.slug]));
  for (const note of rows<NoteRow>("notes")) {
    text(
      markdownPath("notes", note.id, note.title, "note"),
      markdownDocument(
        {
          id: note.id,
          title: note.title,
          project: note.project_id === null ? null : (projectSlugs.get(note.project_id) ?? null),
          pinned: note.pinned_at !== null,
          created: note.created_at,
          updated: note.updated_at,
          created_by: note.created_by,
        },
        md(note.body_md),
      ),
    );
  }

  const topicNames = new Map(rows<NamedRow>("topics").map((t) => [t.id, t.name]));
  const tagNames = new Map(rows<NamedRow>("person_tags").map((t) => [t.id, t.name]));
  const topicsByPerson = groupBy(
    rows<{ person_id: number; topic_id: number }>("person_topics"),
    (r) => r.person_id,
  );
  const tagsByPerson = groupBy(
    rows<{ person_id: number; tag_id: number }>("person_tag_links"),
    (r) => r.person_id,
  );
  const linksByPerson = groupBy(
    rows<{ todo_id: number; person_id: number; role: string }>("todo_people"),
    (r) => r.person_id,
  );
  for (const person of rows<PersonRow>("people")) {
    const links = linksByPerson.get(person.id) ?? [];
    const todoIds = (role: string) =>
      links
        .filter((l) => l.role === role)
        .map((l) => l.todo_id)
        .toSorted((a, b) => a - b);
    const name = `${person.first_name} ${person.last_name}`;
    text(
      markdownPath("people", person.id, name, "person"),
      markdownDocument(
        {
          id: person.id,
          name,
          team: person.team,
          email: person.email,
          note: person.note,
          topics: (topicsByPerson.get(person.id) ?? [])
            .map((r) => topicNames.get(r.topic_id) ?? "")
            .toSorted(compareNames),
          tags: (tagsByPerson.get(person.id) ?? [])
            .map((r) => tagNames.get(r.tag_id) ?? "")
            .toSorted(compareNames),
          requested: todoIds("requester"),
          contact_for: todoIds("contact"),
          created: person.created_at,
        },
        md(person.notes_md),
      ),
    );
  }

  const manifest = {
    app: "organizer",
    format: EXPORT_FORMAT,
    exportedAt: exportedAtIso,
    appVersion: options.appVersion,
    schemaVersion: schemaVersion(ctx.db),
    counts,
    attachments: { count: attachmentFiles.size, bytes, missing },
    sequences: snapshot.sequences,
  };
  text("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  text("data.json", `${JSON.stringify(data, null, 2)}\n`);
  text("README.md", README);

  return {
    fileName: `organizer-export-${fileStamp(exportedAt, tz)}.zip`,
    stream: zipStream(entries, exportedAt),
  };
}

/** Streams the entries as one zip; uploaded files are read in chunks, with backpressure. */
function zipStream(entries: readonly ZipEntry[], mtime: Date): Readable {
  const out = new PassThrough();
  const zip = new Zip((error, chunk, final) => {
    if (error) {
      out.destroy(error);
      return;
    }
    out.write(chunk);
    if (final) out.end();
  });
  const write = async () => {
    for (const entry of entries) {
      const file = entry.stored ? new ZipPassThrough(entry.path) : new ZipDeflate(entry.path, { level: 6 });
      file.mtime = mtime;
      zip.add(file);
      if ("content" in entry) {
        file.push(entry.content, true);
      } else {
        // oxlint-disable-next-line no-await-in-loop -- files are read one after the other
        for await (const chunk of createReadStream(entry.file)) {
          file.push(chunk as Uint8Array);
          // oxlint-disable-next-line no-await-in-loop -- wait for the reader before reading more
          if (out.writableNeedDrain) await once(out, "drain");
        }
        file.push(new Uint8Array(0), true);
      }
      // oxlint-disable-next-line no-await-in-loop -- one entry after the other keeps memory small
      if (out.writableNeedDrain) await once(out, "drain");
    }
    zip.end();
  };
  write().catch((error: unknown) => {
    zip.terminate();
    out.destroy(error as Error);
  });
  return out;
}

/** Collects a stream into one buffer (tests, small zips). */
export async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
