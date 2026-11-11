import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import {
  type BulkUpdateResult,
  CalendarDate,
  Color,
  type Label,
  NEXT_MODES,
  type NextUp,
  type Person,
  type PersonRef,
  priorityOf,
  type Project,
  Slug,
  type Stats,
  TODO_SORTS,
  type Todo,
  type TodoPage,
  TodoStatus,
} from "@organizer/shared";
import { z } from "zod";
import { type Api, ApiError, ToolError } from "./api.ts";
import {
  type DateContext,
  dateContext,
  labelLine,
  nextUpText,
  personLine,
  projectLine,
  statsLine,
  todoDetail,
  todoLine,
  todoLines,
} from "./format.ts";

export interface ToolDeps {
  api: Api;
  timeZone: string;
  now?: () => Date;
}

// ---------- shared input pieces ----------

const format = z
  .enum(["text", "json"])
  .default("text")
  .describe("text (default): compact, one line per todo. json: the full API objects.");

const TodoId = z.number().int().positive().describe("Todo id, the number after # (e.g. 142 for #142).");
const TodoIds = z
  .array(z.number().int().positive())
  .min(1)
  .max(200)
  .describe("Todo ids (1 to 200), the numbers after #.");

const ProjectInput = z
  .union([z.number().int().positive(), z.string().trim().min(1)])
  .describe('Project id, project slug (e.g. "homelab"), or "inbox" for todos without a project.');

const Labels = (what: string) =>
  z
    .array(z.string().trim().min(1))
    .max(50)
    .describe(
      `${what} Names must exist (list_labels). Scoped labels like "priority::high" replace the other label of the same scope.`,
    );

const PersonInput = z.union([
  z.number().int().positive().describe("Person id from list_people."),
  z
    .string()
    .trim()
    .min(3)
    .describe('"First Last". The last word is the last name; use the object form for multi-word last names.'),
  z.strictObject({ firstName: z.string().trim().min(1), lastName: z.string().trim().min(1) }),
]);
const People = (what: string) =>
  z
    .array(PersonInput)
    .max(50)
    .describe(
      `${what} By name, the person is found (case-insensitive) or created if missing. If several people share the name, pass the person id instead.`,
    );

const DateInput = (what: string) =>
  CalendarDate.nullable().describe(`${what} YYYY-MM-DD in the user's local calendar; null clears it.`);

// ---------- helpers ----------

const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

function toPersonRef(input: z.infer<typeof PersonInput>): PersonRef {
  if (typeof input === "number") return { personId: input };
  if (typeof input === "object") return input;
  const words = input.split(/\s+/);
  if (words.length < 2) {
    throw new ToolError(`"${input}" needs a first and a last name, e.g. "Anna Meier", or pass a person id.`);
  }
  return { firstName: words.slice(0, -1).join(" "), lastName: words.at(-1) ?? "" };
}

const toPeople = (list: readonly z.infer<typeof PersonInput>[] | undefined) => list?.map(toPersonRef);

/** Resolves a project id, slug or name to an id; "inbox" is null. */
async function resolveProject(api: Api, input: number | string): Promise<number | null> {
  if (typeof input === "number") return input;
  const key = input.toLowerCase();
  if (key === "inbox") return null;
  const projects = await api.get<Project[]>("/projects");
  const match =
    projects.find((p) => p.slug === key) ?? projects.find((p) => p.name.toLowerCase() === key) ?? null;
  if (!match)
    throw new ToolError(`No project "${input}". list_projects shows them; create_project adds one.`);
  return match.id;
}

async function projectFilter(
  api: Api,
  input: number | string | undefined,
): Promise<number | "inbox" | undefined> {
  if (input === undefined) return undefined;
  return (await resolveProject(api, input)) ?? "inbox";
}

async function projectField(api: Api, input: number | string | null | undefined) {
  if (input === undefined) return undefined;
  return input === null ? null : resolveProject(api, input);
}

/** Drops undefined values so the API only sees the fields that were given. */
function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function errorText(error: unknown): string {
  if (!(error instanceof ToolError)) {
    return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
  }
  const lines = [error.message];
  if (error instanceof ApiError && error.details && typeof error.details === "object") {
    const details = error.details as Record<string, unknown>;
    if (Array.isArray(details.candidates)) {
      lines.push(
        "Candidates (pass one as a person id):",
        ...(details.candidates as Person[]).map(personLine),
      );
    }
    if (details.existing && typeof details.existing === "object") {
      const existing = details.existing as Person | Label;
      lines.push(`Existing: ${"displayName" in existing ? personLine(existing) : labelLine(existing)}`);
    }
    if (Array.isArray(details.unknownLabels)) {
      lines.push("list_labels shows the labels; create_label adds one.");
    }
    if (Array.isArray(details.issues)) {
      for (const issue of details.issues as { path?: string; message?: string }[]) {
        lines.push(`- ${String(issue.path ?? "").replace(/^body\./, "")}: ${issue.message ?? ""}`);
      }
    }
  }
  return lines.join("\n");
}

const out = <T>(fmt: "text" | "json", data: T, text: (data: T) => string): string =>
  fmt === "json" ? JSON.stringify(data) : text(data);

const textResult = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

// ---------- registration ----------

export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { api } = deps;
  const now = deps.now ?? (() => new Date());
  const ctx = (): DateContext => dateContext(now(), deps.timeZone);

  /** Registers a tool whose handler returns text; errors become a readable isError result. */
  function tool<S extends z.ZodRawShape>(
    name: string,
    config: { title: string; description: string; inputSchema: S; annotations: ToolAnnotations },
    run: (args: z.infer<z.ZodObject<S>>) => Promise<string>,
  ): void {
    const callback = async (args: z.infer<z.ZodObject<S>>): Promise<CallToolResult> => {
      try {
        return textResult(await run(args));
      } catch (error) {
        return { ...textResult(errorText(error)), isError: true };
      }
    };
    server.registerTool(name, config, callback as never);
  }

  tool(
    "next_up",
    {
      title: "Next up",
      description:
        "The ranked list of what to work on next, with the reasons (priority, overdue, due soon, planned, age, untouched). " +
        "Start here when the user asks what to do now or wants help prioritizing. Blocked todos are listed apart. " +
        "Modes: smart (default, weighs everything), oldest, priority, due.",
      inputSchema: {
        mode: z.enum(NEXT_MODES).default("smart").describe("Ranking mode."),
        project: ProjectInput.optional(),
        labels: Labels("Only todos with all of these labels.").optional(),
        limit: z.number().int().min(1).max(200).default(20).describe("How many ranked todos (default 20)."),
        format,
      },
      annotations: READ,
    },
    async (args) => {
      const next = await api.get<NextUp>("/next", {
        mode: args.mode,
        projectId: await projectFilter(api, args.project),
        label: args.labels,
        limit: args.limit,
      });
      return out(args.format, next, (data) => nextUpText(data, deps.timeZone));
    },
  );

  tool(
    "overview",
    {
      title: "Overview",
      description:
        "A snapshot for planning: counts (open, overdue, due today, planned today, inbox, done last 7 days), " +
        "open todos per project, the oldest open todos and the open todos without a priority label. " +
        "Use it at the start of a planning or review session.",
      inputSchema: {
        oldest: z.number().int().min(1).max(50).default(10).describe("How many oldest open todos to list."),
        format,
      },
      annotations: READ,
    },
    async (args) => {
      const [stats, projects, page] = await Promise.all([
        api.get<Stats>("/stats"),
        api.get<Project[]>("/projects"),
        api.get<TodoPage>("/todos", { sort: "created", order: "asc", limit: 500 }),
      ]);
      const active = projects.filter((p) => !p.archivedAt);
      const oldest = page.items.slice(0, args.oldest);
      const withoutPriority = page.items.filter((todo) => priorityOf(todo.labels) === null);
      if (args.format === "json") {
        return JSON.stringify({ stats, projects: active, oldest, withoutPriority, activeTotal: page.total });
      }
      const c = ctx();
      const lines = [`Today ${c.today} (${c.timeZone})`, statsLine(stats, c), "", "Open per project:"];
      lines.push(`- inbox: ${stats.inbox}`);
      for (const p of active) lines.push(`- ${p.slug} (${p.name}): ${p.openCount}`);
      lines.push("", `Oldest open todos:`, todoLines(oldest, c, "None."));
      lines.push("", `Without priority (${withoutPriority.length}):`, todoLines(withoutPriority, c, "None."));
      if (page.total > page.items.length) {
        lines.push(`(only the oldest ${page.items.length} of ${page.total} active todos were checked)`);
      }
      return lines.join("\n");
    },
  );

  tool(
    "list_todos",
    {
      title: "List todos",
      description:
        "Search and filter todos. Without a status filter it lists the active ones (open, in progress, blocked). " +
        "Use it to find todos by project, label, person, title text or dates, e.g. before a bulk_update.",
      inputSchema: {
        status: z
          .union([z.literal("all"), z.array(TodoStatus).min(1)])
          .optional()
          .describe(
            'Statuses to include, e.g. ["open","blocked"], or "all". Default: open, in_progress, blocked.',
          ),
        project: ProjectInput.optional(),
        labels: Labels("Only todos with all of these labels.").optional(),
        personId: z.number().int().positive().optional().describe("Only todos requested by this person."),
        q: z.string().trim().max(200).optional().describe("Text in the title (case-insensitive)."),
        dueBefore: CalendarDate.optional().describe("Due before this date (YYYY-MM-DD)."),
        plannedOn: CalendarDate.optional().describe("Planned for exactly this date (YYYY-MM-DD)."),
        sort: z.enum(TODO_SORTS).default("created").describe("Sort field."),
        order: z
          .enum(["asc", "desc"])
          .default("desc")
          .describe("Sort order; priority desc lists critical first."),
        limit: z.number().int().min(1).max(500).default(50).describe("Page size (default 50)."),
        offset: z.number().int().min(0).default(0).describe("Skip this many (paging)."),
        format,
      },
      annotations: READ,
    },
    async (args) => {
      const page = await api.get<TodoPage>("/todos", {
        status: args.status === undefined ? undefined : args.status === "all" ? "all" : args.status,
        projectId: await projectFilter(api, args.project),
        label: args.labels,
        personId: args.personId,
        q: args.q,
        dueBefore: args.dueBefore,
        plannedOn: args.plannedOn,
        sort: args.sort,
        order: args.order,
        limit: args.limit,
        offset: args.offset,
      });
      return out(args.format, page, (data) => {
        const end = data.offset + data.items.length;
        const header =
          data.total === 0
            ? "No todos match."
            : `${data.items.length} of ${data.total} todos${end < data.total ? ` (next page: offset ${end})` : ""}:`;
        return data.total === 0 ? header : `${header}\n${todoLines(data.items, ctx())}`;
      });
    },
  );

  tool(
    "get_todo",
    {
      title: "Get todo",
      description:
        "One todo with all details and its Markdown description. Use it before editing a todo's text.",
      inputSchema: { id: TodoId, format },
      annotations: READ,
    },
    async (args) => {
      const todo = await api.get<Todo>(`/todos/${args.id}`);
      return out(args.format, todo, (data) => todoDetail(data, ctx()));
    },
  );

  tool(
    "create_todo",
    {
      title: "Create todo",
      description:
        "Add a todo. Without a project it lands in the Inbox. Set a priority with a label like priority::high " +
        "(critical, high, medium, low). requestedBy records who asked for it; names are found or created.",
      inputSchema: {
        title: z.string().trim().min(1).max(300).describe("Short title, what needs doing."),
        description: z.string().max(200_000).optional().describe("Details in Markdown."),
        status: TodoStatus.optional().describe("Default open."),
        project: ProjectInput.optional(),
        dueOn: DateInput("Deadline.").optional(),
        plannedOn: DateInput("Day the user plans to work on it.").optional(),
        labels: Labels("Labels to set.").optional(),
        requestedBy: People("Who asked for it.").optional(),
        format,
      },
      annotations: WRITE,
    },
    async (args) => {
      const todo = await api.post<Todo>(
        "/todos",
        compact({
          title: args.title,
          descriptionMd: args.description,
          status: args.status,
          projectId: await projectField(api, args.project),
          dueOn: args.dueOn,
          plannedOn: args.plannedOn,
          labels: args.labels,
          requestedBy: toPeople(args.requestedBy),
        }),
      );
      return out(args.format, todo, (data) => `Created ${todoLine(data, ctx())}`);
    },
  );

  tool(
    "update_todo",
    {
      title: "Update todo",
      description:
        "Change one todo: title, description, status (open, in_progress, blocked, done), project, dates, labels, " +
        "requested by. labels/requestedBy replace the full set; addLabels/removeLabels and addRequestedBy/" +
        "removeRequestedBy change only those. Send only what changes.",
      inputSchema: {
        id: TodoId,
        title: z.string().trim().min(1).max(300).optional(),
        description: z.string().max(200_000).optional().describe("New Markdown description (replaces it)."),
        status: TodoStatus.optional(),
        project: ProjectInput.nullable()
          .optional()
          .describe('Project id or slug; "inbox" or null moves it to the Inbox.'),
        dueOn: DateInput("Deadline.").optional(),
        plannedOn: DateInput("Day the user plans to work on it.").optional(),
        labels: Labels("Full label set (replaces all).").optional(),
        addLabels: Labels("Labels to add.").optional(),
        removeLabels: Labels("Labels to remove.").optional(),
        requestedBy: People("Full requested-by set (replaces all).").optional(),
        addRequestedBy: People("People to add.").optional(),
        removeRequestedBy: People("People to remove (never creates anyone).").optional(),
        format,
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    async (args) => {
      const todo = await api.patch<Todo>(
        `/todos/${args.id}`,
        compact({
          title: args.title,
          descriptionMd: args.description,
          status: args.status,
          projectId: await projectField(api, args.project),
          dueOn: args.dueOn,
          plannedOn: args.plannedOn,
          labels: args.labels,
          addLabels: args.addLabels,
          removeLabels: args.removeLabels,
          requestedBy: toPeople(args.requestedBy),
          addRequestedBy: toPeople(args.addRequestedBy),
          removeRequestedBy: toPeople(args.removeRequestedBy),
        }),
      );
      return out(args.format, todo, (data) => `Updated ${todoLine(data, ctx())}`);
    },
  );

  tool(
    "bulk_update",
    {
      title: "Bulk update",
      description:
        "Apply the same change to many todos at once (all or nothing). Use it to plan a week: one call per day " +
        "with plannedOn set, or to move, relabel or reprioritize a batch.",
      inputSchema: {
        ids: TodoIds,
        status: TodoStatus.optional(),
        project: ProjectInput.nullable()
          .optional()
          .describe('Project id or slug; "inbox" or null moves them to the Inbox.'),
        dueOn: DateInput("Deadline.").optional(),
        plannedOn: DateInput("Day the user plans to work on them.").optional(),
        addLabels: Labels("Labels to add.").optional(),
        removeLabels: Labels("Labels to remove.").optional(),
        format,
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    async (args) => {
      const result = await api.post<BulkUpdateResult>("/todos/bulk", {
        ids: args.ids,
        patch: compact({
          status: args.status,
          projectId: await projectField(api, args.project),
          dueOn: args.dueOn,
          plannedOn: args.plannedOn,
          addLabels: args.addLabels,
          removeLabels: args.removeLabels,
        }),
      });
      return out(
        args.format,
        result,
        (data) => `Updated ${data.updated.length}:\n${todoLines(data.updated, ctx())}`,
      );
    },
  );

  tool(
    "mark_done",
    {
      title: "Mark done",
      description:
        "Mark one or more todos done; the result shows how long each took. To reopen, use update_todo with status open.",
      inputSchema: { ids: TodoIds, format },
      annotations: { ...WRITE, idempotentHint: true },
    },
    async (args) => {
      const result = await api.post<BulkUpdateResult>("/todos/bulk", {
        ids: args.ids,
        patch: { status: "done" },
      });
      return out(args.format, result, (data) => `Done:\n${todoLines(data.updated, ctx())}`);
    },
  );

  tool(
    "list_projects",
    {
      title: "List projects",
      description:
        "Projects with id, slug, name and number of open todos. Slugs work wherever a project is asked for.",
      inputSchema: {
        includeArchived: z.boolean().default(false).describe("Also list archived projects."),
        format,
      },
      annotations: READ,
    },
    async (args) => {
      const all = await api.get<Project[]>("/projects");
      const projects = args.includeArchived ? all : all.filter((p) => !p.archivedAt);
      return out(args.format, projects, (data) =>
        data.length === 0 ? "No projects yet. create_project adds one." : data.map(projectLine).join("\n"),
      );
    },
  );

  tool(
    "create_project",
    {
      title: "Create project",
      description: "Add a project to group todos. The slug is derived from the name when left out.",
      inputSchema: {
        name: z.string().trim().min(1).max(100),
        slug: Slug.optional().describe("Lowercase letters, digits and dashes, e.g. home-lab."),
        description: z.string().max(2000).optional(),
        color: Color.optional().describe("Hex color like #8B95A5."),
        format,
      },
      annotations: WRITE,
    },
    async (args) => {
      const { format: fmt, ...body } = args;
      const project = await api.post<Project>("/projects", compact(body));
      return out(fmt, project, (data) => `Created ${projectLine(data)}`);
    },
  );

  tool(
    "list_labels",
    {
      title: "List labels",
      description:
        'All labels. Scoped labels ("scope::value", like priority::high) allow one per scope on a todo; priority ' +
        "labels drive the Next up ranking.",
      inputSchema: { format },
      annotations: READ,
    },
    async (args) => {
      const labels = await api.get<Label[]>("/labels");
      return out(args.format, labels, (data) =>
        data.length === 0 ? "No labels." : data.map(labelLine).join("\n"),
      );
    },
  );

  tool(
    "create_label",
    {
      title: "Create label",
      description:
        'Add a label. Plain ("homelab") or scoped ("area::network"; everything before the last "::" is the scope). ' +
        "Ask the user before adding labels they did not mention.",
      inputSchema: {
        name: z.string().trim().min(1).max(100),
        color: Color.optional().describe("Hex color like #8B95A5."),
        description: z.string().max(2000).optional(),
        rank: z.number().int().min(0).nullable().optional().describe("Order inside its scope (0 first)."),
        format,
      },
      annotations: WRITE,
    },
    async (args) => {
      const { format: fmt, ...body } = args;
      const label = await api.post<Label>("/labels", compact(body));
      return out(fmt, label, (data) => `Created ${labelLine(data)}`);
    },
  );

  tool(
    "list_people",
    {
      title: "List people",
      description:
        "People who request todos, with ids and notes that tell namesakes apart. q searches names and notes.",
      inputSchema: { q: z.string().trim().max(200).optional(), format },
      annotations: READ,
    },
    async (args) => {
      const people = await api.get<Person[]>("/people", { q: args.q });
      return out(args.format, people, (data) =>
        data.length === 0 ? "No people match." : data.map(personLine).join("\n"),
      );
    },
  );

  tool(
    "create_person",
    {
      title: "Create person",
      description:
        "Add a person. Usually not needed: create_todo and update_todo create people by name. Fails if the name " +
        "exists, unless allowDuplicate is true (then give a note that tells them apart).",
      inputSchema: {
        firstName: z.string().trim().min(1).max(100),
        lastName: z.string().trim().min(1).max(100),
        note: z.string().max(2000).optional().describe("E.g. team or role."),
        allowDuplicate: z.boolean().optional(),
        format,
      },
      annotations: WRITE,
    },
    async (args) => {
      const { format: fmt, ...body } = args;
      const person = await api.post<Person>("/people", compact(body));
      return out(fmt, person, (data) => `Created ${personLine(data)}`);
    },
  );
}
