import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import {
  type Activity,
  type BulkUpdateResult,
  CalendarDate,
  Color,
  type Comment,
  type Label,
  NEXT_MODES,
  type NextUp,
  type Note,
  type NotePage,
  type Person,
  PersonRole,
  type PersonRef,
  type PersonTag,
  priorityOf,
  type Project,
  SEARCH_KINDS,
  type SearchResult,
  Slug,
  type Stats,
  TODO_SORTS,
  type Todo,
  type TodoPage,
  TodoStatus,
  type Topic,
} from "@organizer/shared";
import { z } from "zod";
import { type Api, ApiError, ToolError } from "./api.ts";
import {
  activityLine,
  type DateContext,
  dateContext,
  labelLine,
  nextUpText,
  noteDetail,
  noteLine,
  personDetail,
  personLine,
  personTagLine,
  projectLine,
  searchText,
  statsLine,
  todoDetail,
  todoLine,
  todoLines,
  topicLine,
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

const TopicNames = (what: string) =>
  z
    .array(z.string().trim().min(1).max(60))
    .max(50)
    .describe(`${what} Topics are what a person can help with ("firewall rules"); new names are created.`);

const TagNames = (what: string) =>
  z
    .array(z.string().trim().min(1).max(60))
    .max(30)
    .describe(`${what} Person tags must exist (list_person_tags); they are the user's own judgments.`);

const NoteId = z.number().int().positive().describe("Note id from list_notes.");

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

/** Same text ignoring case (accents still count, like the server's name match). */
const sameName = (a: string, b: string): boolean =>
  a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;

/** Finds one person by id or exact name (case-insensitive); several namesakes list the candidates. */
async function resolvePerson(api: Api, input: z.infer<typeof PersonInput>): Promise<number> {
  const ref = toPersonRef(input);
  if ("personId" in ref) return ref.personId;
  const name = `${ref.firstName} ${ref.lastName}`;
  const found = await api.get<Person[]>("/people", { q: name });
  const matches = found.filter(
    (p) => sameName(p.firstName, ref.firstName) && sameName(p.lastName, ref.lastName),
  );
  if (matches.length === 1 && matches[0]) return matches[0].id;
  if (matches.length === 0) {
    throw new ToolError(`No person named "${name}". list_people searches by name, team and topic.`);
  }
  throw new ToolError(
    [`Several people are named "${name}"; pass the person id:`, ...matches.map(personLine)].join("\n"),
  );
}

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

/** Project of a note: id or slug; "inbox", "none" or null mean no project. */
async function noteProject(api: Api, input: number | string | null | undefined) {
  if (input === undefined) return undefined;
  if (input === null || (typeof input === "string" && input.toLowerCase() === "none")) return null;
  return resolveProject(api, input);
}

/** Drops undefined values so the API only sees the fields that were given. */
function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function existingLine(existing: Person | Label | PersonTag | Topic): string {
  if ("displayName" in existing) return personLine(existing);
  if ("scope" in existing) return labelLine(existing);
  if ("color" in existing) return personTagLine(existing);
  return topicLine(existing);
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
      lines.push(`Existing: ${existingLine(details.existing as Person | Label | PersonTag | Topic)}`);
    }
    if (Array.isArray(details.unknownLabels)) {
      lines.push("list_labels shows the labels; create_label adds one.");
    }
    if (Array.isArray(details.unknownTags)) {
      lines.push("list_person_tags shows the person tags; the user adds new ones on the Labels page.");
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
        "Use it to find todos by project, label, person (requester or contact), title text or dates, e.g. before a " +
        "bulk_update. For a week plan, use plannedFrom/plannedTo; unplanned lists what has no day yet.",
      inputSchema: {
        status: z
          .union([z.literal("all"), z.array(TodoStatus).min(1)])
          .optional()
          .describe(
            'Statuses to include, e.g. ["open","blocked"], or "all". Default: open, in_progress, blocked.',
          ),
        project: ProjectInput.optional(),
        labels: Labels("Only todos with all of these labels.").optional(),
        personId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Only todos linked to this person (as requester unless personRole says otherwise)."),
        personRole: z
          .enum([...PersonRole.options, "any"])
          .optional()
          .describe("With personId: requester (default), contact, or any."),
        q: z.string().trim().max(200).optional().describe("Text in the title (case-insensitive)."),
        dueBefore: CalendarDate.optional().describe("Due before this date (YYYY-MM-DD)."),
        plannedOn: CalendarDate.optional().describe("Planned for exactly this date (YYYY-MM-DD)."),
        plannedFrom: CalendarDate.optional().describe("Planned on or after this date (YYYY-MM-DD)."),
        plannedTo: CalendarDate.optional().describe("Planned on or before this date (YYYY-MM-DD)."),
        unplanned: z
          .boolean()
          .optional()
          .describe("true: only todos without a planned day (not together with plannedFrom/plannedTo)."),
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
        personRole: args.personRole,
        q: args.q,
        dueBefore: args.dueBefore,
        plannedOn: args.plannedOn,
        plannedFrom: args.plannedFrom,
        plannedTo: args.plannedTo,
        unplanned: args.unplanned,
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
        "(critical, high, medium, low). requestedBy records who asked for it, contacts who to ask about it; " +
        "names are found or created.",
      inputSchema: {
        title: z.string().trim().min(1).max(300).describe("Short title, what needs doing."),
        description: z.string().max(200_000).optional().describe("Details in Markdown."),
        status: TodoStatus.optional().describe("Default open."),
        project: ProjectInput.optional(),
        dueOn: DateInput("Deadline.").optional(),
        plannedOn: DateInput("Day the user plans to work on it.").optional(),
        labels: Labels("Labels to set.").optional(),
        requestedBy: People("Who asked for it.").optional(),
        contacts: People("Who to ask or involve (colleagues who know the topic).").optional(),
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
          contacts: toPeople(args.contacts),
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
        "requested by, contacts. labels/requestedBy/contacts replace the full set; the add*/remove* fields " +
        "change only those (e.g. addContacts adds a colleague to ask). Send only what changes.",
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
        contacts: People("Full contact set (replaces all).").optional(),
        addContacts: People("Contacts to add.").optional(),
        removeContacts: People("Contacts to remove (never creates anyone).").optional(),
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
          contacts: toPeople(args.contacts),
          addContacts: toPeople(args.addContacts),
          removeContacts: toPeople(args.removeContacts),
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
        'The user\'s directory of colleagues. Use it to answer "whom do I ask about X": filter by topic (what ' +
        "they help with), team or person tag, or search q over names, team, email, notes and topics. One line " +
        "per person: id, name, team, topics, tags, how many todos they requested or are a contact for.",
      inputSchema: {
        q: z.string().trim().max(200).optional().describe("Text in name, team, email, short note or topics."),
        topic: z
          .array(z.string().trim().min(1))
          .max(10)
          .optional()
          .describe("Only people with all these topics."),
        team: z.string().trim().min(1).max(100).optional().describe("Exact team name (case-insensitive)."),
        tag: z
          .array(z.string().trim().min(1))
          .max(10)
          .optional()
          .describe("Only people with all these person tags."),
        kind: z
          .enum(["requester", "contact"])
          .optional()
          .describe(
            "requester: asked for a todo at least once. contact: a contact on a todo or has a topic.",
          ),
        sort: z
          .enum(["name", "requested", "contact", "recent"])
          .default("name")
          .describe("name (default), requested or contact (most first), recent (newest todo link first)."),
        format,
      },
      annotations: READ,
    },
    async (args) => {
      const people = await api.get<Person[]>("/people", {
        q: args.q,
        topic: args.topic,
        team: args.team,
        tag: args.tag,
        kind: args.kind,
        sort: args.sort,
      });
      return out(args.format, people, (data) =>
        data.length === 0
          ? "No people match. Fewer filters, or list_topics, show what is there."
          : data.map(personLine).join("\n"),
      );
    },
  );

  tool(
    "get_person",
    {
      title: "Get person",
      description:
        "One person with everything: short note, team, email, topics, tags, counts, the Markdown notes, and the " +
        "open todos they requested and the ones they are a contact for.",
      inputSchema: {
        person: PersonInput.describe('Person id, or "First Last" (exact name).'),
        format,
      },
      annotations: READ,
    },
    async (args) => {
      const id = await resolvePerson(api, args.person);
      const [person, requested, contactFor] = await Promise.all([
        api.get<Person>(`/people/${id}`),
        api.get<TodoPage>("/todos", { personId: id, personRole: "requester", sort: "created", limit: 100 }),
        api.get<TodoPage>("/todos", { personId: id, personRole: "contact", sort: "created", limit: 100 }),
      ]);
      const todos = { requested: requested.items, contactFor: contactFor.items };
      return out(args.format, { person, ...todos }, (data) => personDetail(data.person, todos, ctx()));
    },
  );

  const personFields = {
    note: z
      .string()
      .max(2000)
      .optional()
      .describe('Short hint shown next to the name, e.g. "Platform team, Basel" (tells namesakes apart).'),
    team: z.string().trim().max(100).optional().describe('Team or department, e.g. "Network team".'),
    email: z
      .union([z.literal(""), z.email()])
      .optional()
      .describe("Email address (enables mail and chat links); empty text removes it."),
    notes: z.string().max(200_000).optional().describe("Longer notes about the person in Markdown."),
  };

  tool(
    "create_person",
    {
      title: "Create person",
      description:
        "Add a person to the directory, with team, email, topics they help with and person tags. create_todo " +
        "and update_todo also create people by name. Fails if the name exists, unless allowDuplicate is true " +
        "(then give a note that tells them apart).",
      inputSchema: {
        firstName: z.string().trim().min(1).max(100),
        lastName: z.string().trim().min(1).max(100),
        ...personFields,
        topics: TopicNames("What they can help with.").optional(),
        tags: TagNames("Person tags to set.").optional(),
        allowDuplicate: z.boolean().optional(),
        format,
      },
      annotations: WRITE,
    },
    async (args) => {
      const { format: fmt, notes, ...body } = args;
      const person = await api.post<Person>("/people", compact({ ...body, notesMd: notes }));
      return out(fmt, person, (data) => `Created ${personLine(data)}`);
    },
  );

  tool(
    "update_person",
    {
      title: "Update person",
      description:
        "Change a person: name, short note, team, email, notes, topics and tags. topics/tags replace the full " +
        "set; addTopics/removeTopics and addTags/removeTags change only those. Does not touch their todos.",
      inputSchema: {
        person: PersonInput.describe('Person id, or "First Last" (exact name).'),
        firstName: z.string().trim().min(1).max(100).optional(),
        lastName: z.string().trim().min(1).max(100).optional(),
        ...personFields,
        topics: TopicNames("Full topic set (replaces all).").optional(),
        addTopics: TopicNames("Topics to add.").optional(),
        removeTopics: TopicNames("Topics to remove.").optional(),
        tags: TagNames("Full tag set (replaces all).").optional(),
        addTags: TagNames("Tags to add.").optional(),
        removeTags: TagNames("Tags to remove.").optional(),
        format,
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    async (args) => {
      const { format: fmt, person: input, notes, ...fields } = args;
      const id = await resolvePerson(api, input);
      const person = await api.patch<Person>(`/people/${id}`, compact({ ...fields, notesMd: notes }));
      return out(fmt, person, (data) => `Updated ${personLine(data)}`);
    },
  );

  tool(
    "list_topics",
    {
      title: "List topics",
      description:
        "Topics people help with, with how many people have each. Use the names as the topic filter of list_people.",
      inputSchema: {
        q: z.string().trim().max(60).optional().describe("Part of the topic name (case-insensitive)."),
        limit: z.number().int().min(1).max(500).default(100).describe("How many (default 100)."),
        format,
      },
      annotations: READ,
    },
    async (args) => {
      const topics = await api.get<Topic[]>("/topics", { q: args.q, limit: args.limit });
      return out(args.format, topics, (data) =>
        data.length === 0 ? "No topics match." : data.map(topicLine).join("\n"),
      );
    },
  );

  tool(
    "list_person_tags",
    {
      title: "List person tags",
      description:
        'The user\'s own tags for colleagues ("fast reply", "needs a ticket"), with color, people count and ' +
        "description. Only these names can be set on people.",
      inputSchema: { format },
      annotations: READ,
    },
    async (args) => {
      const tags = await api.get<PersonTag[]>("/person-tags");
      return out(args.format, tags, (data) =>
        data.length === 0 ? "No person tags yet." : data.map(personTagLine).join("\n"),
      );
    },
  );

  tool(
    "get_activity",
    {
      title: "Get activity",
      description:
        "The thread of one todo, oldest first: every change (status, labels, people, dates, ...) and every " +
        "comment with its text, one line each with local time and who did it.",
      inputSchema: {
        todo: TodoId,
        limit: z.number().int().min(1).max(2000).optional().describe("Only the newest N items."),
        format,
      },
      annotations: READ,
    },
    async (args) => {
      const activity = await api.get<Activity>(`/todos/${args.todo}/activity`);
      const items = args.limit === undefined ? activity.items : activity.items.slice(-args.limit);
      return out(args.format, { ...activity, items }, (data) => {
        if (data.items.length === 0) return `#${data.todoId} has no activity yet.`;
        const shown = items.length < activity.items.length ? `, the newest ${items.length}` : "";
        return [
          `#${data.todoId} activity (${activity.items.length} items${shown}):`,
          ...data.items.map((item) => activityLine(item, deps.timeZone)),
        ].join("\n");
      });
    },
  );

  tool(
    "add_comment",
    {
      title: "Add comment",
      description:
        "Add a comment to a todo's thread (Markdown), e.g. a status update or what was found out. It is signed " +
        "with this connection's name. #123 in the text links to todo 123.",
      inputSchema: {
        todo: TodoId,
        text: z.string().min(1).max(50_000).describe("The comment in Markdown."),
        format,
      },
      annotations: WRITE,
    },
    async (args) => {
      const comment = await api.post<Comment>(`/todos/${args.todo}/comments`, { bodyMd: args.text });
      return out(
        args.format,
        comment,
        (data) => `Added comment ${data.id} to #${data.todoId} as ${data.actor}.`,
      );
    },
  );

  tool(
    "search",
    {
      title: "Search",
      description:
        "Full-text search over todos (title and description), notes, comments and people (name, team, email, " +
        "topics). Ignores case and accents. #123 finds todo 123 first. Results are grouped by kind with snippets.",
      inputSchema: {
        q: z.string().trim().min(1).max(200).describe("Words to find; all of them must match."),
        kinds: z.array(z.enum(SEARCH_KINDS)).min(1).optional().describe("Only these kinds (default all)."),
        limit: z.number().int().min(1).max(100).default(10).describe("Hits per kind (default 10)."),
        format,
      },
      annotations: READ,
    },
    async (args) => {
      const result = await api.get<SearchResult>("/search", {
        q: args.q,
        kinds: args.kinds,
        limit: args.limit,
      });
      return out(args.format, result, searchText);
    },
  );

  tool(
    "list_notes",
    {
      title: "List notes",
      description:
        "The user's notes (Markdown pages, optionally in a project): pinned first, then most recently updated. " +
        "One line each with an excerpt; get_note shows the full text.",
      inputSchema: {
        project: ProjectInput.optional().describe(
          'Project id or slug; "inbox" or "none" for notes without one.',
        ),
        pinned: z.boolean().optional().describe("true: only pinned, false: only unpinned."),
        q: z.string().trim().max(200).optional().describe("Text in the title (case-insensitive)."),
        limit: z.number().int().min(1).max(500).default(50).describe("Page size (default 50)."),
        offset: z.number().int().min(0).default(0).describe("Skip this many (paging)."),
        format,
      },
      annotations: READ,
    },
    async (args) => {
      const project = await noteProject(api, args.project);
      const page = await api.get<NotePage>("/notes", {
        projectId: project === null ? "none" : project,
        pinned: args.pinned,
        q: args.q,
        limit: args.limit,
        offset: args.offset,
      });
      return out(args.format, page, (data) => {
        if (data.total === 0) return "No notes match. create_note adds one.";
        const end = data.offset + data.items.length;
        const next = end < data.total ? ` (next page: offset ${end})` : "";
        return [
          `${data.items.length} of ${data.total} notes${next}:`,
          ...data.items.map((n) => noteLine(n, ctx())),
        ].join("\n");
      });
    },
  );

  tool(
    "get_note",
    {
      title: "Get note",
      description: "One note with its full Markdown text. Use it before editing a note.",
      inputSchema: { id: NoteId, format },
      annotations: READ,
    },
    async (args) => {
      const note = await api.get<Note>(`/notes/${args.id}`);
      return out(args.format, note, (data) => noteDetail(data, ctx()));
    },
  );

  tool(
    "create_note",
    {
      title: "Create note",
      description:
        "Write a new note (Markdown), e.g. meeting notes, a how-to or a list that is not a todo. Optionally in a " +
        "project and pinned to the top.",
      inputSchema: {
        title: z.string().trim().min(1).max(200),
        body: z.string().max(200_000).optional().describe("The note in Markdown."),
        project: ProjectInput.optional(),
        pinned: z.boolean().optional(),
        format,
      },
      annotations: WRITE,
    },
    async (args) => {
      const note = await api.post<Note>(
        "/notes",
        compact({
          title: args.title,
          bodyMd: args.body,
          projectId: await noteProject(api, args.project),
          pinned: args.pinned,
        }),
      );
      return out(args.format, note, (data) => `Created ${noteLine(data, ctx())}`);
    },
  );

  tool(
    "update_note",
    {
      title: "Update note",
      description:
        "Change a note: title, body (replaces it), project, pinned. appendText adds text at the end instead, " +
        "e.g. a new entry in a log note, without resending the whole body.",
      inputSchema: {
        id: NoteId,
        title: z.string().trim().min(1).max(200).optional(),
        body: z.string().max(200_000).optional().describe("New Markdown body (replaces it)."),
        appendText: z
          .string()
          .min(1)
          .max(200_000)
          .optional()
          .describe("Markdown to add at the end, after a blank line (not together with body)."),
        project: ProjectInput.nullable()
          .optional()
          .describe('Project id or slug; "inbox", "none" or null removes the project.'),
        pinned: z.boolean().optional(),
        format,
      },
      annotations: WRITE,
    },
    async (args) => {
      if (args.body !== undefined && args.appendText !== undefined) {
        throw new ToolError("Give either body (replaces the text) or appendText (adds to it), not both.");
      }
      let body = args.body;
      if (args.appendText !== undefined) {
        const current = await api.get<Note>(`/notes/${args.id}`);
        const base = current.bodyMd.replace(/\s+$/, "");
        body = base === "" ? args.appendText : `${base}\n\n${args.appendText}`;
      }
      const note = await api.patch<Note>(
        `/notes/${args.id}`,
        compact({
          title: args.title,
          bodyMd: body,
          projectId: await noteProject(api, args.project),
          pinned: args.pinned,
        }),
      );
      return out(args.format, note, (data) => `Updated ${noteLine(data, ctx())}`);
    },
  );
}
