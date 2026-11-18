import { statSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  describeRecurrence,
  describeSeries,
  EXPORT_FORMAT,
  type ExportManifest,
  formatDate,
  formatDateTime,
  formatDuration,
  INLINE_IMAGE_TYPES,
  languageNames,
  RecurrenceRule,
  StandupFilter,
  toLocalDate,
  todoDurationMs,
} from "@organizer/shared";
import { asc } from "drizzle-orm";
import { strToU8 } from "fflate";
import { stringify } from "yaml";
import { schemaVersion } from "../db/index.ts";
import { ID_TABLES, todos } from "../db/schema.ts";
import type { Ctx } from "./context.ts";
import { owned } from "./owned.ts";
import { decodeLanguages } from "./people.ts";
import { type ZipEntry, zipStream } from "./zip-writer.ts";
import { slugify } from "./projects.ts";
import { LAST_EXPORT_AT, LOCAL_SETTING_KEYS, setSetting } from "./settings.ts";
import { compareNames } from "./text.ts";
import { hydrate } from "./todos.ts";

export { EXPORT_FORMAT };

/**
 * Tables in the export (data.json names), in restore order (parents before children). Never api_tokens,
 * search_fts, account rows or secrets. "settings" holds the account's settings (account_settings).
 */
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
  "todo_urls",
  "time_blocks",
  "notes",
  "meetings",
  "series",
  "series_exceptions",
  "meeting_notes",
  "standup_marks",
  "meeting_todos",
  "comments",
  "attachments",
  "events",
  "settings",
] as const;

export type ExportTable = (typeof EXPORT_TABLES)[number];

/** The database table behind a data.json table. */
export const dbTable = (table: string): string => (table === "settings" ? "account_settings" : table);

/**
 * Columns left out of data.json: derived from other columns (refilled after a restore) or only valid on
 * this server. A restore ignores them when a file has them. account_id is never in data.json either: any
 * export fits any account.
 */
export const LOCAL_COLUMNS: Partial<Record<(typeof EXPORT_TABLES)[number], readonly string[]>> = {
  labels: ["name_key"],
  topics: ["name_key"],
  person_tags: ["name_key"],
  comments: ["author_token_id"],
};

/** The row without account_id and the local columns of its table. */
export function withoutLocalColumns(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const local = LOCAL_COLUMNS[table as keyof typeof LOCAL_COLUMNS] ?? [];
  return Object.fromEntries(
    Object.entries(row).filter(([name]) => name !== "account_id" && !local.includes(name)),
  );
}

const README = `# Sloppanizer export

This archive is a complete copy of one Sloppanizer account's data (its sign-in data, API tokens and
the server's settings are left out). Export format ${EXPORT_FORMAT}.

- manifest.json: app, export format, time of export, app and schema version, the account (username
  and display name), row counts per table, the attachments (count, bytes, ids of files that were
  missing on disk) and the id sequences of every table (so a restore never gives out an old id again).
- data.json: every row of every table with its original id (column names as in the database,
  without account_id, name_key and comments.author_token_id, which a restore fills in again). This
  is the file a restore reads.
  Text is kept exactly as stored, links included.
- attachments/: every uploaded file as <id>-<name>.
- todos/: one Markdown file per todo (NNNN-title.md): YAML front matter with the main fields
  (also parent, subtasks, links, repeat, planned time that repeats with it, previous and next
  occurrence), then the description and the comments.
- notes/: one Markdown file per note (NNNN-title.md): front matter, then the note.
- people/: one Markdown file per person (NNNN-first-last.md): team, email, languages, topics,
  tags, the todos they requested or are a contact for, then the notes about them.
- meetings/: one Markdown file per meeting (NNNN-name.md): type, repeat (one line per part),
  cancelled and moved dates, the standup filter (project slugs and label names) and where the
  standup list counts from, then the todos added to it by hand, the notes of its dates (linked
  into notes/) and the todos said at each date.

In the Markdown files, links to uploaded files point into attachments/, so images show up in any
Markdown viewer. The Markdown files are for reading and searching; a restore does not need them.

Restore: in Sloppanizer open Settings, Restore, and pick this zip. It reads data.json and
attachments/ and replaces the data of the account you are signed in to, after saving a safety copy
of its current data. Any account can restore any export, and exports of the single-user organizer
(formats 1 to 3) can be restored too.
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
    (c) => `### ${c.actor}, ${formatDateTime(c.createdAt, timeZone)}\n\n${c.bodyMd.replace(/\s+$/, "")}`,
  );
  return `## Comments\n\n${blocks.join("\n\n")}`;
}

// ---------- rows as stored (data.json column names) ----------

interface MeetingRow {
  id: number;
  name: string;
  type: string;
  filter: string;
  since: string;
  created_at: string;
}
interface SeriesRow {
  id: number;
  owner_kind: string;
  meeting_id: number | null;
  todo_id: number | null;
  rule: string;
  starts_on: string;
  ends_on: string | null;
  start_time: string;
  duration_min: number;
}
interface ExceptionRow {
  series_id: number;
  occurs_on: string;
  kind: string;
  start_at: string | null;
}
interface MeetingNoteRow {
  meeting_id: number;
  occurs_on: string;
  note_id: number;
}
interface MeetingTodoRow {
  meeting_id: number;
  todo_id: number;
  added_at: string;
}
interface MarkRow {
  meeting_id: number;
  todo_id: number;
  occurs_on: string;
  kind: string;
}

interface PersonRow {
  id: number;
  first_name: string;
  last_name: string;
  note: string;
  team: string;
  email: string;
  notes_md: string;
  languages: string;
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

type Rows = <T>(table: ExportTable) => T[];

/** One segment's repeat in words, "from 12.11.2026: every week on Thu, 09:00–09:15". */
function segmentText(s: SeriesRow): string {
  const rule = RecurrenceRule.safeParse(JSON.parse(s.rule));
  const text = rule.success
    ? describeSeries({
        rule: rule.data,
        startsOn: s.starts_on,
        endsOn: s.ends_on,
        startTime: s.start_time,
        durationMinutes: s.duration_min,
      })
    : `${s.start_time}, ${s.duration_min} minutes`;
  return `from ${formatDate(s.starts_on)}: ${text}`;
}

const filterOf = (json: string): { projectIds: number[]; inbox: boolean; labelIds: number[] } => {
  const parsed = StandupFilter.safeParse(JSON.parse(json));
  return parsed.success ? parsed.data : { projectIds: [], inbox: false, labelIds: [] };
};

/**
 * meetings/NNNN-name.md: type, repeat per segment, cancelled and moved dates, the filter by project slug
 * and label name, the window start; then the notes of its dates and the todos said per date.
 */
function meetingFiles(
  rows: Rows,
  text: (path: string, content: string) => void,
  names: {
    timeZone: string;
    todoTitles: ReadonlyMap<number, string>;
    projectSlugs: ReadonlyMap<number, string>;
  },
): void {
  const labelNames = new Map(rows<NamedRow>("labels").map((l) => [l.id, l.name]));
  const notes = new Map(rows<NoteRow>("notes").map((n) => [n.id, n]));
  const segmentsOf = groupBy(rows<SeriesRow>("series"), (s) => s.meeting_id);
  const exceptionsOf = groupBy(rows<ExceptionRow>("series_exceptions"), (e) => e.series_id);
  const notesOf = groupBy(rows<MeetingNoteRow>("meeting_notes"), (n) => n.meeting_id);
  const todosOf = groupBy(rows<MeetingTodoRow>("meeting_todos"), (m) => m.meeting_id);
  const saidOf = groupBy(
    rows<MarkRow>("standup_marks").filter((m) => m.kind === "said"),
    (m) => m.meeting_id,
  );
  for (const meeting of rows<MeetingRow>("meetings")) {
    const segments = (segmentsOf.get(meeting.id) ?? []).toSorted((a, b) =>
      a.starts_on.localeCompare(b.starts_on),
    );
    const exceptions = segments
      .flatMap((s) => exceptionsOf.get(s.id) ?? [])
      .toSorted((a, b) => a.occurs_on.localeCompare(b.occurs_on));
    const filter = filterOf(meeting.filter);
    const noteLines = (notesOf.get(meeting.id) ?? [])
      .toSorted((a, b) => a.occurs_on.localeCompare(b.occurs_on))
      .flatMap((link) => {
        const note = notes.get(link.note_id);
        if (!note) return [];
        const path = markdownPath("notes", note.id, note.title, "note");
        return [`- ${formatDate(link.occurs_on)}: [${note.title}](../${path})`];
      });
    const said = groupBy(
      (saidOf.get(meeting.id) ?? []).toSorted(
        (a, b) => a.occurs_on.localeCompare(b.occurs_on) || a.todo_id - b.todo_id,
      ),
      (m) => m.occurs_on,
    );
    const saidBlocks = [...said].map(
      ([date, marks]) =>
        `### ${formatDate(date)}\n\n${marks
          .map((m) => `- #${m.todo_id} ${names.todoTitles.get(m.todo_id) ?? ""}`.trimEnd())
          .join("\n")}`,
    );
    const todoLines = (todosOf.get(meeting.id) ?? [])
      .toSorted((a, b) => a.added_at.localeCompare(b.added_at) || a.todo_id - b.todo_id)
      .map((m) => `- #${m.todo_id} ${names.todoTitles.get(m.todo_id) ?? ""}`.trimEnd());
    const body = [
      todoLines.length > 0 ? `## Todos\n\n${todoLines.join("\n")}` : "",
      noteLines.length > 0 ? `## Notes\n\n${noteLines.join("\n")}` : "",
      saidBlocks.length > 0 ? `## Said\n\n${saidBlocks.join("\n\n")}` : "",
    ]
      .filter((x) => x !== "")
      .join("\n\n");
    text(
      markdownPath("meetings", meeting.id, meeting.name, "meeting"),
      markdownDocument(
        {
          id: meeting.id,
          name: meeting.name,
          type: meeting.type,
          schedule: segments.map(segmentText),
          cancelled: exceptions.filter((e) => e.kind === "cancelled").map((e) => e.occurs_on),
          moved: exceptions
            .filter((e) => e.kind === "moved" && e.start_at !== null)
            .map((e) => ({ date: e.occurs_on, to: formatDateTime(e.start_at as string, names.timeZone) })),
          filter: {
            projects: filter.projectIds.flatMap((id) => names.projectSlugs.get(id) ?? []),
            inbox: filter.inbox,
            labels: filter.labelIds.flatMap((id) => labelNames.get(id) ?? []),
          },
          since: meeting.since,
          created: meeting.created_at,
        },
        body,
      ),
    );
  }
}

export interface ExportOptions {
  /** The account's files folder (<files dir>/<account id>). */
  filesDir: string;
  appVersion: string;
  /** Names the account in the manifest. */
  account: { username: string; displayName: string };
  /** false: leave lastExportAt alone (the safety copy before a restore). Default true. */
  recordExport?: boolean;
}

export interface ExportResult {
  fileName: string;
  /** The zip, produced while it is read; errors (a file gone missing) destroy the stream. */
  stream: Readable;
}

/** The highest id ever given per id table of the account, so a restore never hands out an id again. */
function sequences(ctx: Ctx): Record<string, number> {
  const sqlite = ctx.db.$client;
  const stored = new Map(
    (
      sqlite
        .prepare("SELECT table_name, last_id FROM account_sequences WHERE account_id = ?")
        .all(ctx.accountId) as { table_name: string; last_id: number }[]
    ).map((r) => [r.table_name, r.last_id]),
  );
  return Object.fromEntries(
    ID_TABLES.map((table) => {
      const { maxId } = sqlite
        .prepare(`SELECT coalesce(max(id), 0) AS maxId FROM "${table}" WHERE account_id = ?`)
        .get(ctx.accountId) as { maxId: number };
      return [table, Math.max(stored.get(table) ?? 0, maxId)];
    }),
  );
}

/**
 * Builds the export of the context's account (format 6) and stores its lastExportAt. The database is read in one
 * snapshot right away; the zip is streamed, and uploaded files are read from disk while it streams,
 * so memory stays small even with many files.
 */
export function buildExport(ctx: Ctx, options: ExportOptions): ExportResult {
  const exportedAt = ctx.clock();
  const exportedAtIso = exportedAt.toISOString();
  const tz = ctx.timeZone;
  // Store the export time first so the copy includes it, like a backup taken right now.
  if (options.recordExport !== false) setSetting(ctx, LAST_EXPORT_AT, exportedAtIso);

  const sqlite = ctx.db.$client;
  const data: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  const readAll = sqlite.transaction(() => {
    for (const table of EXPORT_TABLES) {
      const skip =
        table === "settings" ? ` AND key NOT IN (${LOCAL_SETTING_KEYS.map(() => "?").join(", ")})` : "";
      const params = table === "settings" ? [ctx.accountId, ...LOCAL_SETTING_KEYS] : [ctx.accountId];
      const rows = (
        sqlite
          .prepare(`SELECT * FROM "${dbTable(table)}" WHERE account_id = ?${skip} ORDER BY rowid`)
          .all(...params) as Record<string, unknown>[]
      ).map((row) => withoutLocalColumns(table, row));
      data[table] = rows;
      counts[table] = rows.length;
    }
    return {
      todos: hydrate(ctx, ctx.db.select().from(todos).where(owned(ctx, todos)).orderBy(asc(todos.id)).all()),
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
    const file = join(options.filesDir, String(attachment.id));
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
  // Planned time that repeats with a todo, on the todo that owns it (the open one of its repeat).
  const plannedTimeOf = groupBy(
    rows<SeriesRow>("series")
      .filter((s) => s.owner_kind === "todo")
      .toSorted((a, b) => a.starts_on.localeCompare(b.starts_on)),
    (s) => s.todo_id,
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
          planned_time: plannedTimeOf.get(todo.id)?.map(segmentText) ?? null,
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
          languages: languageNames(decodeLanguages(person.languages)),
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

  meetingFiles(rows, text, {
    timeZone: tz,
    todoTitles: new Map(allTodos.map((t) => [t.id, t.title])),
    projectSlugs,
  });

  const manifest: ExportManifest = {
    app: "sloppanizer",
    format: EXPORT_FORMAT,
    exportedAt: exportedAtIso,
    appVersion: options.appVersion,
    schemaVersion: schemaVersion(ctx.db),
    account: { username: options.account.username, displayName: options.account.displayName },
    counts,
    sequences: snapshot.sequences,
    attachments: { count: attachmentFiles.size, bytes, missing },
  };
  text("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  text("data.json", `${JSON.stringify(data, null, 2)}\n`);
  text("README.md", README);

  return {
    fileName: `sloppanizer-export-${fileStamp(exportedAt, tz)}.zip`,
    stream: zipStream(entries, exportedAt),
  };
}

/** Collects a stream into one buffer (tests, small zips). */
export async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
