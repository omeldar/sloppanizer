import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatDuration,
  INLINE_IMAGE_TYPES,
  toLocalDate,
  toLocalDateTime,
  todoDurationMs,
} from "@organizer/shared";
import { asc } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { stringify } from "yaml";
import { schemaVersion } from "../db/index.ts";
import { todos } from "../db/schema.ts";
import type { Ctx } from "./context.ts";
import { slugify } from "./projects.ts";
import { setSetting } from "./settings.ts";
import { LAST_EXPORT_AT } from "./stats.ts";
import { hydrate } from "./todos.ts";

export const EXPORT_FORMAT = 2;

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
  "notes",
  "comments",
  "attachments",
  "events",
  "settings",
] as const;

const README = `# organizer export

This archive is a complete copy of your organizer data (API tokens and the secret are left out).
Export format 2.

- manifest.json: app, export format, time of export, app and schema version, row counts per table,
  and the attachments (count, bytes, ids of files that were missing on disk).
- data.json: every row of every table with its original id (column names as in the database).
  This is the file a restore reads. Text is kept exactly as stored, links included.
- attachments/: every uploaded file as <id>-<name>.
- todos/: one Markdown file per todo (NNNN-title.md): YAML front matter with the main fields,
  then the description and the comments.
- notes/: one Markdown file per note (NNNN-title.md): front matter, then the note.
- people/: one Markdown file per person (NNNN-first-last.md): team, email, topics, tags, the todos
  they requested or are a contact for, then the notes about them.

In the Markdown files, links to uploaded files point into attachments/, so images show up in any
Markdown viewer. The Markdown files are for reading and searching; a restore does not need them.

Restore: a restore comes in a later version of organizer and reads data.json and attachments/
(format 1 archives, without notes, comments, attachments and contacts, stay restorable too).
Until then keep the zip; it holds everything needed to rebuild the database with the same ids.
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
function fileStamp(date: Date, timeZone: string): string {
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

const byName = (a: string, b: string): number => a.localeCompare(b, "en", { sensitivity: "base" });

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
}

export interface ExportResult {
  fileName: string;
  zip: Uint8Array;
}

/** Builds the export zip (format 2) and stores settings.lastExportAt. */
export function buildExport(ctx: Ctx, options: ExportOptions): ExportResult {
  const exportedAt = ctx.clock();
  const exportedAtIso = exportedAt.toISOString();
  const tz = ctx.timeZone;
  // Store the export time first so the copy includes it, like a backup taken right now.
  setSetting(ctx.db, LAST_EXPORT_AT, exportedAtIso);

  const sqlite = ctx.db.$client;
  const data: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  const readAll = sqlite.transaction(() => {
    for (const table of EXPORT_TABLES) {
      const rows = sqlite.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
      data[table] = rows;
      counts[table] = rows.length;
    }
    return hydrate(ctx.db, ctx.db.select().from(todos).orderBy(asc(todos.id)).all());
  });
  const allTodos = readAll();
  const rows = <T>(table: (typeof EXPORT_TABLES)[number]) => (data[table] ?? []) as T[];

  // Attachments first: the Markdown links point at the files that made it into the zip.
  // Path -> content; files listed in `stored` are put in the zip without compression.
  const files: Record<string, Uint8Array> = {};
  const stored = new Set<string>();
  const attachmentFiles = new Map<number, string>();
  const missing: number[] = [];
  let bytes = 0;
  for (const attachment of rows<AttachmentRow>("attachments")) {
    let content: Buffer;
    try {
      content = readFileSync(join(options.attachmentsDir, String(attachment.id)));
    } catch {
      missing.push(attachment.id);
      continue;
    }
    const name = attachmentFileName(attachment);
    attachmentFiles.set(attachment.id, name);
    bytes += content.byteLength;
    const path = `attachments/${name}`;
    files[path] = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    if (STORED_TYPES.has(attachment.mime_type)) stored.add(path);
  }
  const md = (text: string) => rewriteAttachmentLinks(text, attachmentFiles);

  const commentsByTodo = groupBy(
    rows<CommentRow>("comments").toSorted((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id),
    (c) => c.todo_id,
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
    const body = [md(todo.descriptionMd).replace(/\s+$/, ""), comments].filter((s) => s !== "").join("\n\n");
    files[markdownPath("todos", todo.id, todo.title, "todo")] = strToU8(
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
        },
        body,
      ),
    );
  }

  const projectSlugs = new Map(rows<{ id: number; slug: string }>("projects").map((p) => [p.id, p.slug]));
  for (const note of rows<NoteRow>("notes")) {
    files[markdownPath("notes", note.id, note.title, "note")] = strToU8(
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
    files[markdownPath("people", person.id, name, "person")] = strToU8(
      markdownDocument(
        {
          id: person.id,
          name,
          team: person.team,
          email: person.email,
          note: person.note,
          topics: (topicsByPerson.get(person.id) ?? [])
            .map((r) => topicNames.get(r.topic_id) ?? "")
            .toSorted(byName),
          tags: (tagsByPerson.get(person.id) ?? []).map((r) => tagNames.get(r.tag_id) ?? "").toSorted(byName),
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
  };
  files["manifest.json"] = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);
  files["data.json"] = strToU8(`${JSON.stringify(data, null, 2)}\n`);
  files["README.md"] = strToU8(README);

  const mtime = exportedAt;
  const zip = zipSync(
    Object.fromEntries(
      Object.entries(files).map(([path, content]) => [
        path,
        [content, { mtime, level: stored.has(path) ? 0 : 6 }] as const,
      ]),
    ),
  );
  return { fileName: `organizer-export-${fileStamp(exportedAt, tz)}.zip`, zip };
}
