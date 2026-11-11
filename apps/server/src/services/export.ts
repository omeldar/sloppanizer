import { formatDuration, toLocalDate, todoDurationMs } from "@organizer/shared";
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

export const EXPORT_FORMAT = 1;

/** Tables in the export, in restore order (parents before children). Never api_tokens or the secret. */
export const EXPORT_TABLES = [
  "projects",
  "labels",
  "people",
  "todos",
  "todo_labels",
  "todo_people",
  "events",
  "settings",
] as const;

const README = `# organizer export

This archive is a complete copy of your organizer data (API tokens and the secret are left out).

- manifest.json: app, export format, time of export, app and schema version, row counts per table.
- data.json: every row of every table with its original id (column names as in the database).
  This is the file a restore reads.
- todos/: one Markdown file per todo (NNNN-title.md): YAML front matter with the main fields,
  then the description. Easy to read or search; a restore does not need them.

Restore: a restore from this format comes in a later version of organizer. Until then keep the
zip; it holds everything needed to rebuild the database with the same ids.
`;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local wall-clock stamp for the file name, e.g. 20261111-153000. */
function fileStamp(date: Date, timeZone: string): string {
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
  const day = toLocalDate(date, timeZone).replaceAll("-", "");
  return `${day}-${pad(parts.hour ?? 0)}${pad(parts.minute ?? 0)}${pad(parts.second ?? 0)}`;
}

export interface ExportResult {
  fileName: string;
  zip: Uint8Array;
}

/** Builds the export zip and stores settings.lastExportAt. */
export function buildExport(ctx: Ctx, appVersion: string): ExportResult {
  const exportedAt = ctx.clock();
  const exportedAtIso = exportedAt.toISOString();
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

  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(
      `${JSON.stringify(
        {
          app: "organizer",
          format: EXPORT_FORMAT,
          exportedAt: exportedAtIso,
          appVersion,
          schemaVersion: schemaVersion(ctx.db),
          counts,
        },
        null,
        2,
      )}\n`,
    ),
    "data.json": strToU8(`${JSON.stringify(data, null, 2)}\n`),
    "README.md": strToU8(README),
  };
  for (const todo of allTodos) {
    const duration = todoDurationMs(todo.createdAt, todo.doneAt);
    const frontMatter = {
      id: todo.id,
      title: todo.title,
      status: todo.status,
      project: todo.project?.slug ?? null,
      labels: todo.labels.map((l) => l.name),
      requested_by: todo.requestedBy.map((p) => p.displayName),
      due: todo.dueOn,
      planned: todo.plannedOn,
      created: todo.createdAt,
      done: todo.doneAt,
      took: todo.status === "done" && duration !== null ? formatDuration(duration) : null,
    };
    const name = `todos/${String(todo.id).padStart(4, "0")}-${slugify(todo.title, "todo").slice(0, 50).replace(/-+$/, "")}.md`;
    const body = `---\n${stringify(frontMatter)}---\n\n${todo.descriptionMd}${todo.descriptionMd.endsWith("\n") || todo.descriptionMd === "" ? "" : "\n"}`;
    files[name] = strToU8(body);
  }
  const mtime = exportedAt;
  const zip = zipSync(
    Object.fromEntries(Object.entries(files).map(([path, content]) => [path, [content, { mtime }]])),
    { level: 6 },
  );
  return { fileName: `organizer-export-${fileStamp(exportedAt, ctx.timeZone)}.zip`, zip };
}
