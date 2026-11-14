import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import {
  type Activity,
  type ChecklistItem,
  BulkUpdate,
  type BulkUpdateResult,
  CalendarDate,
  type Comment,
  CreateComment,
  CreateLabel,
  CreateNote,
  CreatePerson,
  CreateProject,
  CreateSubtasks,
  CreateTodo,
  type Label,
  LinkKind,
  NextQuery,
  type NextUp,
  type Note,
  NoteListQuery,
  type NotePage,
  parseChecklist,
  type PeopleStats,
  PeopleStatsQuery,
  type Person,
  PersonRef,
  PersonTagName,
  type PersonTag,
  PeopleQuery,
  priorityOf,
  type Project,
  RecurrenceRule,
  SearchKind,
  SearchQuery,
  type SearchResult,
  type Me,
  type Stats,
  type Todo,
  TodoListQuery,
  type TodoPage,
  TodoStatus,
  type Topic,
  TopicName,
  TopicQuery,
  UpdateNote,
  UpdatePerson,
  UpdateTodo,
  addDays as addLocalDays,
  CalendarDate as PlanDate,
  localTimeToInstant,
  type TimeBlock,
  toLocalDate as planLocalDate,
  toLocalTime,
  UrlInput,
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
  peopleStatsText,
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
  urlLines,
} from "./format.ts";

export interface ToolDeps {
  api: Api;
  timeZone: string;
  now?: () => Date;
  /** WSL distribution, to show Windows paths of written files. */
}

// ---------- shared input pieces ----------

const format = z
  .enum(["text", "json"])
  .default("text")
  .describe("text (default): compact, one line per todo. json: the full API objects.");

const TodoId = z.number().int().positive().describe("Todo id, the number after # (e.g. 142 for #142).");
const TodoIds = BulkUpdate.shape.ids.describe("Todo ids (1 to 200), the numbers after #.");

const ProjectInput = z
  .union([z.number().int().positive(), z.string().trim().min(1)])
  .describe('Project id, project slug (e.g. "homelab"), or "inbox" for todos without a project.');

const Labels = (what: string) =>
  CreateTodo.shape.labels
    .unwrap()
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
  PersonRef.options[1],
]);
const People = (what: string) =>
  z
    .array(PersonInput)
    .max(50)
    .describe(
      `${what} By name, the person is found (case-insensitive) or created if missing. If several people share the name, pass the person id instead.`,
    );

const TopicNames = (what: string) =>
  CreatePerson.shape.topics
    .unwrap()
    .describe(`${what} Topics are what a person can help with ("firewall rules"); new names are created.`);

const TagNames = (what: string) =>
  CreatePerson.shape.tags
    .unwrap()
    .describe(`${what} Person tags must exist (list_person_tags); they are the user's own judgments.`);

const Repeat = RecurrenceRule.nullable().describe(
  'Repeat rule; null stops repeating. Needs dueOn or plannedOn. Examples: {"every":"week","weekdays":["mon"]}, ' +
    '{"every":"month","monthDay":-1} (last day), {"every":"month","monthWeekday":{"nth":2,"weekday":"tue"}}, ' +
    '{"every":"day","interval":3,"basis":"done"} (3 days after it was done), "until":"2026-12-31" ends it. ' +
    "When a repeating todo is marked done, the next one is created with the dates moved.",
);

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
    if (Array.isArray(details.chain)) {
      lines.push(`Chain: ${(details.chain as number[]).map((id) => `#${id}`).join(" blocks ")}`);
    }
    if (Array.isArray(details.unknownTodoIds)) {
      lines.push(`Unknown todos: ${(details.unknownTodoIds as number[]).map((id) => `#${id}`).join(", ")}`);
    }
    if (Array.isArray(details.items)) {
      lines.push("The checklist now reads:", ...(details.items as ChecklistItem[]).map(checklistLine));
    }
    if (Array.isArray(details.issues)) {
      for (const issue of details.issues as { path?: string; message?: string }[]) {
        lines.push(`- ${String(issue.path ?? "").replace(/^body\./, "")}: ${issue.message ?? ""}`);
      }
    }
  }
  return lines.join("\n");
}

const checklistLine = (item: ChecklistItem): string =>
  `[${item.checked ? "x" : " "}] ${item.index} ${item.text}`;

const LINK_TEXT: Record<LinkKind, string> = {
  blocks: "blocks",
  blocked_by: "is blocked by",
  relates: "relates to",
};

/** Open subtasks of these todos, all levels down (subtasks nest up to 5 levels). */
async function openDescendants(api: Api, ids: readonly number[]): Promise<number[]> {
  const found: number[] = [];
  let level = [...ids];
  while (level.length > 0) {
    // oxlint-disable-next-line no-await-in-loop -- one level after the other, each level in parallel
    const pages = await Promise.all(
      level.map((parentId) => api.get<TodoPage>("/todos", { parentId, limit: 500 })),
    );
    level = pages.flatMap((page) => page.items.map((todo) => todo.id)).filter((id) => !found.includes(id));
    found.push(...level);
  }
  return found;
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
        mode: NextQuery.shape.mode.describe("Ranking mode."),
        project: ProjectInput.optional(),
        labels: Labels("Only todos with all of these labels.").optional(),
        limit: NextQuery.shape.limit.unwrap().default(20).describe("How many ranked todos (default 20)."),
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
        "Use it at the start of a planning or review session. Includes today's planned time blocks.",
      inputSchema: {
        oldest: z.number().int().min(1).max(50).default(10).describe("How many oldest open todos to list."),
        format,
      },
      annotations: READ,
    },
    async (args) => {
      const day = ctx().today;
      const [me, stats, projects, page, plan] = await Promise.all([
        api.get<Me>("/me"),
        api.get<Stats>("/stats"),
        api.get<Project[]>("/projects"),
        api.get<TodoPage>("/todos", { sort: "created", order: "asc", limit: 500 }),
        // Today's planner; an older server without it just leaves the section out.
        api.get<TimeBlock[]>("/blocks", { from: day, to: day }).catch(() => null),
      ]);
      const active = projects.filter((p) => !p.archivedAt);
      const oldest = page.items.slice(0, args.oldest);
      const withoutPriority = page.items.filter((todo) => priorityOf(todo.labels) === null);
      if (args.format === "json") {
        return JSON.stringify({
          account: me.account.username,
          stats,
          projects: active,
          oldest,
          withoutPriority,
          activeTotal: page.total,
          plannedToday: plan,
        });
      }
      const c = ctx();
      const lines = [
        `Account ${me.account.username}`,
        `Today ${c.today} (${c.timeZone})`,
        statsLine(stats, c),
      ];
      if (plan) lines.push("", "Planned today (list_plan shows more days):", blockLines(plan));
      lines.push("", "Open per project:");
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
        parent: TodoListQuery.shape.parentId.describe(
          'Only the subtasks of this todo id, or "none" for top-level todos only.',
        ),
        personRole: TodoListQuery.shape.personRole
          .unwrap()
          .optional()
          .describe("With personId: requester (default), contact, or any."),
        q: TodoListQuery.shape.q.describe("Text in the title (case-insensitive)."),
        dueBefore: CalendarDate.optional().describe("Due before this date (YYYY-MM-DD)."),
        plannedOn: CalendarDate.optional().describe("Planned for exactly this date (YYYY-MM-DD)."),
        plannedFrom: CalendarDate.optional().describe("Planned on or after this date (YYYY-MM-DD)."),
        plannedTo: CalendarDate.optional().describe("Planned on or before this date (YYYY-MM-DD)."),
        unplanned: z
          .boolean()
          .optional()
          .describe("true: only todos without a planned day (not together with plannedFrom/plannedTo)."),
        sort: TodoListQuery.shape.sort.describe("Sort field."),
        order: TodoListQuery.shape.order.describe("Sort order; priority desc lists critical first."),
        limit: TodoListQuery.shape.limit.unwrap().default(50).describe("Page size (default 50)."),
        offset: TodoListQuery.shape.offset.describe("Skip this many (paging)."),
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
        parentId: args.parent,
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
        "One todo with all details: parent, subtasks, checklist items with their numbers, links (blocks, " +
        "blocked by, relates to), repeat rule and its Markdown description. Use it before editing a todo's text.",
      inputSchema: { id: TodoId, format },
      annotations: READ,
    },
    async (args) => {
      const todo = await api.get<Todo>(`/todos/${args.id}`);
      const subtasks =
        todo.progress.subtasks.total === 0
          ? []
          : (
              await api.get<TodoPage>("/todos", {
                parentId: todo.id,
                status: "all",
                sort: "position",
                order: "asc",
                limit: 500,
              })
            ).items;
      return out(args.format, todo, (data) => todoDetail(data, ctx(), subtasks));
    },
  );

  tool(
    "create_todo",
    {
      title: "Create todo",
      description:
        "Add a todo. Without a project it lands in the Inbox. Set a priority with a label like priority::high " +
        "(critical, high, medium, low). requestedBy records who asked for it, contacts who to ask about it; " +
        "names are found or created. parent makes it a subtask; repeat makes it come back (a new todo is " +
        "created for the next date when it is marked done).",
      inputSchema: {
        title: CreateTodo.shape.title.describe("Short title, what needs doing."),
        description: CreateTodo.shape.descriptionMd.describe("Details in Markdown."),
        status: TodoStatus.optional().describe("Default open."),
        project: ProjectInput.optional(),
        dueOn: DateInput("Deadline.").optional(),
        plannedOn: DateInput("Day the user plans to work on it.").optional(),
        labels: Labels("Labels to set.").optional(),
        requestedBy: People("Who asked for it.").optional(),
        contacts: People("Who to ask or involve (colleagues who know the topic).").optional(),
        parent: TodoId.optional().describe(
          "Makes it a subtask of this todo. Without project it takes the parent's project.",
        ),
        repeat: Repeat.optional(),
        links: z
          .array(UrlInput)
          .max(50)
          .optional()
          .describe("Web links (tickets, docs, pull requests): url and an optional label."),
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
          parentId: args.parent,
          recurrence: args.repeat,
          urls: args.links,
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
        "change only those (e.g. addContacts adds a colleague to ask). parent moves it under another todo " +
        "(null: top level again); repeat sets or stops (null) the repeat rule. Send only what changes.",
      inputSchema: {
        id: TodoId,
        title: UpdateTodo.shape.title,
        description: UpdateTodo.shape.descriptionMd.describe("New Markdown description (replaces it)."),
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
        parent: TodoId.nullable()
          .optional()
          .describe("Make it a subtask of this todo; null: top level again."),
        repeat: Repeat.optional(),
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
          parentId: args.parent,
          recurrence: args.repeat,
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
        "Mark one or more todos done; the result shows how long each took and the next occurrence of a " +
        "repeating todo. withSubtasks also marks their open subtasks done. To reopen, use update_todo with " +
        "status open.",
      inputSchema: {
        ids: TodoIds,
        withSubtasks: z.boolean().default(false).describe("Also mark the open subtasks (all levels) done."),
        format,
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    async (args) => {
      const ids = args.withSubtasks
        ? [...new Set([...args.ids, ...(await openDescendants(api, args.ids))])]
        : args.ids;
      if (ids.length > 200) {
        throw new ToolError(`With their subtasks these are ${ids.length} todos; mark at most 200 at once.`);
      }
      const result = await api.post<BulkUpdateResult>("/todos/bulk", { ids, patch: { status: "done" } });
      const nextRefs = result.updated.flatMap((todo) => (todo.nextOccurrence ? [todo.nextOccurrence] : []));
      const next = await Promise.all(nextRefs.map((ref) => api.get<Todo>(`/todos/${ref.id}`)));
      return out(args.format, { ...result, nextOccurrences: next }, (data) => {
        const lines = [`Done:`, todoLines(data.updated, ctx())];
        if (next.length > 0) lines.push("Next occurrence:", todoLines(next, ctx()));
        return lines.join("\n");
      });
    },
  );

  tool(
    "add_subtasks",
    {
      title: "Add subtasks",
      description:
        "Add subtasks (child todos) under a todo, in the given order. They take the parent's project. For a " +
        "quick list of steps inside one todo, a Markdown checklist in its description works too (check_item).",
      inputSchema: {
        todo: TodoId.describe("The parent todo id."),
        titles: CreateSubtasks.shape.titles.describe("Titles of the new subtasks (1 to 50)."),
        format,
      },
      annotations: WRITE,
    },
    async (args) => {
      const created = await api.post<Todo[]>(`/todos/${args.todo}/subtasks`, { titles: args.titles });
      return out(
        args.format,
        created,
        (data) =>
          `Added ${data.length} subtask${data.length === 1 ? "" : "s"} to #${args.todo}:\n${todoLines(data, ctx())}`,
      );
    },
  );

  tool(
    "check_item",
    {
      title: "Check item",
      description:
        "Tick or untick one checklist item (a Markdown task list line like - [ ] Order cables) in a todo's " +
        "description. get_todo lists the items with their numbers. Only that one item changes.",
      inputSchema: {
        todo: TodoId,
        item: z
          .union([z.number().int().min(0), z.string().trim().min(1)])
          .describe("The item number from get_todo, or its exact text."),
        checked: z.boolean().default(true).describe("true ticks it (default), false unticks it."),
        format,
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    async (args) => {
      const current = await api.get<Todo>(`/todos/${args.todo}`);
      const items = parseChecklist(current.descriptionMd);
      if (items.length === 0) throw new ToolError(`#${args.todo} has no checklist in its description.`);
      const wanted = args.item;
      let matches: ChecklistItem[];
      if (typeof wanted === "number") {
        matches = items.filter((item) => item.index === wanted);
      } else {
        matches = items.filter((item) => item.text.trim() === wanted);
        if (matches.length === 0) {
          const lower = wanted.toLowerCase();
          matches = items.filter((item) => item.text.trim().toLowerCase() === lower);
        }
      }
      const [item] = matches;
      if (!item || matches.length > 1) {
        const problem =
          matches.length > 1
            ? `Several items read "${String(wanted)}"; pass the number.`
            : `No item ${typeof wanted === "number" ? wanted : `"${wanted}"`} on #${args.todo}.`;
        throw new ToolError([problem, "The checklist reads:", ...items.map(checklistLine)].join("\n"));
      }
      const todo = await api.post<Todo>(`/todos/${args.todo}/checklist`, {
        index: item.index,
        checked: args.checked,
        text: item.text,
      });
      return out(
        args.format,
        todo,
        (data) => `${args.checked ? "Checked" : "Unchecked"} "${item.text}" on ${todoLine(data, ctx())}`,
      );
    },
  );

  tool(
    "link_todos",
    {
      title: "Link todos",
      description:
        "Link two todos: blocks (this todo must be done first), blocked_by (the other one must be done first) " +
        "or relates (just related). A todo waiting on an open blocker leaves the Next up ranking until the " +
        "blocker is done; a blocker gets extra points.",
      inputSchema: {
        todo: TodoId,
        kind: LinkKind.describe("blocks, blocked_by or relates, seen from todo."),
        other: TodoId.describe("The other todo id."),
        format,
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    async (args) => {
      const todo = await api.post<Todo>(`/todos/${args.todo}/links`, {
        links: [{ kind: args.kind, todoId: args.other }],
      });
      return out(
        args.format,
        todo,
        (data) => `Linked: #${args.todo} ${LINK_TEXT[args.kind]} #${args.other}.\n${todoLine(data, ctx())}`,
      );
    },
  );

  tool(
    "unlink_todos",
    {
      title: "Unlink todos",
      description: "Remove a link between two todos (the same kind as when it was added, seen from todo).",
      inputSchema: {
        todo: TodoId,
        kind: LinkKind.describe("blocks, blocked_by or relates, seen from todo."),
        other: TodoId.describe("The other todo id."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      await api.delete(`/todos/${args.todo}/links/${args.other}`, { kind: args.kind });
      return `Removed the link: #${args.todo} ${LINK_TEXT[args.kind]} #${args.other}.`;
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
        name: CreateProject.shape.name,
        slug: CreateProject.shape.slug.describe("Lowercase letters, digits and dashes, e.g. home-lab."),
        description: CreateProject.shape.description,
        color: CreateProject.shape.color.describe("Hex color like #8B95A5."),
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
        name: CreateLabel.shape.name,
        color: CreateLabel.shape.color.describe("Hex color like #8B95A5."),
        description: CreateLabel.shape.description,
        rank: CreateLabel.shape.rank.describe("Order inside its scope (0 first)."),
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
        q: PeopleQuery.shape.q.describe("Text in name, team, email, short note or topics."),
        topic: z.array(TopicName).max(10).optional().describe("Only people with all these topics."),
        team: PeopleQuery.shape.team.describe("Exact team name (case-insensitive)."),
        tag: z.array(PersonTagName).max(10).optional().describe("Only people with all these person tags."),
        kind: PeopleQuery.shape.kind.describe(
          "requester: asked for a todo at least once. contact: a contact on a todo or has a topic.",
        ),
        sort: PeopleQuery.shape.sort.describe(
          "name (default), requested or contact (most first), recent (newest todo link first).",
        ),
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
    note: CreatePerson.shape.note.describe(
      'Short hint shown next to the name, e.g. "Platform team, Basel" (tells namesakes apart).',
    ),
    team: CreatePerson.shape.team.describe('Team or department, e.g. "Network team".'),
    email: CreatePerson.shape.email.describe(
      "Email address (enables mail and chat links); empty text removes it.",
    ),
    notes: CreatePerson.shape.notesMd.describe("Longer notes about the person in Markdown."),
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
        firstName: CreatePerson.shape.firstName,
        lastName: CreatePerson.shape.lastName,
        ...personFields,
        topics: TopicNames("What they can help with.").optional(),
        tags: TagNames("Person tags to set.").optional(),
        allowDuplicate: CreatePerson.shape.allowDuplicate,
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
        firstName: UpdatePerson.shape.firstName,
        lastName: UpdatePerson.shape.lastName,
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
    "people_stats",
    {
      title: "People statistics",
      description:
        "Who asks for how much and how fast it gets done: per person the todos they requested (total, open, " +
        "done, median time to done) and how often they are a contact. Filter the people by topic, tag or team " +
        "and the todos by created date (from, to), labels or project.",
      inputSchema: {
        from: PeopleStatsQuery.shape.from.describe("Todos created on or after this date (YYYY-MM-DD)."),
        to: PeopleStatsQuery.shape.to.describe("Todos created on or before this date (YYYY-MM-DD)."),
        role: PeopleStatsQuery.shape.role.describe(
          "requester (default): people who asked for todos; contact: people to ask about them.",
        ),
        topic: z.array(TopicName).max(10).optional().describe("Only people with all these topics."),
        tag: z.array(PersonTagName).max(10).optional().describe("Only people with all these person tags."),
        team: PeopleStatsQuery.shape.team.describe("Exact team name (case-insensitive)."),
        labels: Labels("Only todos with all of these labels.").optional(),
        project: ProjectInput.optional(),
        sort: PeopleStatsQuery.shape.sort.describe(
          "total (default), open, done, speed (fastest median first), recent or name.",
        ),
        limit: PeopleStatsQuery.shape.limit.describe("How many people (default 50)."),
        format,
      },
      annotations: READ,
    },
    async (args) => {
      const stats = await api.get<PeopleStats>("/stats/people", {
        from: args.from,
        to: args.to,
        role: args.role,
        topic: args.topic,
        tag: args.tag,
        team: args.team,
        label: args.labels,
        projectId: await projectFilter(api, args.project),
        sort: args.sort,
        limit: args.limit,
      });
      return out(args.format, stats, peopleStatsText);
    },
  );

  tool(
    "list_topics",
    {
      title: "List topics",
      description:
        "Topics people help with, with how many people have each. Use the names as the topic filter of list_people.",
      inputSchema: {
        q: TopicQuery.shape.q.describe("Part of the topic name (case-insensitive)."),
        limit: TopicQuery.shape.limit.unwrap().default(100).describe("How many (default 100)."),
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
        text: CreateComment.shape.bodyMd.describe("The comment in Markdown."),
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
        q: SearchQuery.shape.q.describe("Words to find; all of them must match."),
        kinds: z.array(SearchKind).min(1).optional().describe("Only these kinds (default all)."),
        limit: SearchQuery.shape.limit.unwrap().default(10).describe("Hits per kind (default 10)."),
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
        q: NoteListQuery.shape.q.describe("Text in the title (case-insensitive)."),
        limit: NoteListQuery.shape.limit.unwrap().default(50).describe("Page size (default 50)."),
        offset: NoteListQuery.shape.offset.describe("Skip this many (paging)."),
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
        title: CreateNote.shape.title,
        body: CreateNote.shape.bodyMd.describe("The note in Markdown."),
        project: ProjectInput.optional(),
        pinned: CreateNote.shape.pinned,
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
        title: UpdateNote.shape.title,
        body: UpdateNote.shape.bodyMd.describe("New Markdown body (replaces it)."),
        appendText: UpdateNote.shape.appendMd.describe(
          "Markdown to add at the end, after a blank line (not together with body).",
        ),
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
      // The server appends inside its transaction, so an edit in the web app at the same time is kept.
      const note = await api.patch<Note>(
        `/notes/${args.id}`,
        compact({
          title: args.title,
          bodyMd: args.body,
          appendMd: args.appendText,
          projectId: await noteProject(api, args.project),
          pinned: args.pinned,
        }),
      );
      return out(args.format, note, (data) => `Updated ${noteLine(data, ctx())}`);
    },
  );

  // ---------- web links ----------

  tool(
    "add_web_link",
    {
      title: "Add web link",
      description:
        "Attach a web link to a todo (a ticket, doc, pull request, mail thread). A bare host gets https://. " +
        "A URL the todo has already is skipped. get_todo lists the links with their ids.",
      inputSchema: {
        todo: TodoId,
        url: UrlInput.shape.url,
        label: UrlInput.shape.label.describe("Short name shown instead of the URL (optional)."),
        format,
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    async (args) => {
      const todo = await api.post<Todo>(`/todos/${args.todo}/urls`, {
        urls: [compact({ url: args.url, label: args.label })],
      });
      return out(args.format, todo, (data) => `Links of ${todoLine(data, ctx())}\n${urlLines(data)}`);
    },
  );

  tool(
    "remove_web_link",
    {
      title: "Remove web link",
      description: "Remove a web link from a todo, by its link id (get_todo shows it) or its exact URL.",
      inputSchema: {
        todo: TodoId,
        link: z.union([z.number().int().positive(), z.string().min(1)]).describe("Link id or the exact URL."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const current = await api.get<Todo>(`/todos/${args.todo}`);
      const match = current.urls.find((u) => u.id === args.link || u.url === args.link);
      if (!match) {
        throw new ToolError(
          `#${args.todo} has no link ${String(args.link)}. Its links:\n${urlLines(current)}`,
        );
      }
      await api.delete(`/todos/${args.todo}/urls/${match.id}`);
      const todo = await api.get<Todo>(`/todos/${args.todo}`);
      return `Removed ${match.url} from #${args.todo}.\n${urlLines(todo)}`;
    },
  );

  // ---------- planner ----------

  const Time = z
    .string()
    .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "Use HH:MM, 24 hours.")
    .describe("Local time HH:MM (24 hours) in the user's time zone.");
  const BlockId = z.number().int().positive().describe("Time block id from list_plan.");
  const blockLine = (b: TimeBlock): string => {
    const day = planLocalDate(b.startAt, deps.timeZone);
    const endDay = planLocalDate(b.endAt, deps.timeZone);
    const endText = `${endDay === day ? "" : `${endDay} `}${toLocalTime(b.endAt, deps.timeZone)}`;
    const what = b.todo
      ? `#${b.todo.id} ${b.todo.title}${b.todo.status === "done" ? " (done)" : ""}`
      : b.title;
    const project = b.project ? ` [${b.project.name}]` : "";
    return `block ${b.id} | ${day} ${toLocalTime(b.startAt, deps.timeZone)}-${endText} | ${what}${project}`;
  };
  const blockLines = (blocks: readonly TimeBlock[]): string =>
    blocks.length === 0 ? "Nothing planned." : blocks.map(blockLine).join("\n");

  tool(
    "list_plan",
    {
      title: "List planned time",
      description:
        "The user's planner: time blocks reserved for todos (or with their own title) between two days, " +
        "in local time. Default: today and the next 6 days. Use it before plan_time to find free time.",
      inputSchema: {
        from: PlanDate.optional().describe("First day YYYY-MM-DD (default today)."),
        to: PlanDate.optional().describe("Last day YYYY-MM-DD (default from + 6)."),
        todo: TodoId.optional().describe("Only the blocks of this todo."),
        format,
      },
      annotations: READ,
    },
    async (args) => {
      const from = args.from ?? ctx().today;
      const to = args.to ?? addLocalDays(from, 6);
      const blocks = await api.get<TimeBlock[]>("/blocks", { from, to, todoId: args.todo });
      return out(args.format, blocks, (data) => `Plan ${from} to ${to}:\n${blockLines(data)}`);
    },
  );

  tool(
    "plan_time",
    {
      title: "Plan time",
      description:
        "Reserve time in the user's planner: for a todo (todo) or with its own title (title), on a day from " +
        "start to end (local HH:MM), or from start for minutes. Check list_plan first so blocks do not clash.",
      inputSchema: {
        todo: TodoId.optional(),
        title: z.string().trim().max(200).optional().describe("Title of a block without a todo."),
        date: PlanDate.describe("Day YYYY-MM-DD."),
        start: Time,
        end: Time.optional().describe("Local end time HH:MM; or give minutes."),
        minutes: z.number().int().min(5).max(1440).optional().describe("Length in minutes (instead of end)."),
        format,
      },
      annotations: WRITE,
    },
    async (args) => {
      if (args.todo === undefined && !args.title)
        throw new ToolError("Give a todo or a title for the block.");
      const startAt = localTimeToInstant(args.date, args.start, deps.timeZone);
      let endAt: Date;
      if (args.end !== undefined) {
        endAt = localTimeToInstant(args.date, args.end, deps.timeZone);
        if (endAt <= startAt) endAt = localTimeToInstant(addLocalDays(args.date, 1), args.end, deps.timeZone);
      } else if (args.minutes !== undefined) {
        endAt = new Date(startAt.getTime() + args.minutes * 60_000);
      } else {
        throw new ToolError("Give end (HH:MM) or minutes.");
      }
      const block = await api.post<TimeBlock>(
        "/blocks",
        compact({
          todoId: args.todo,
          title: args.title,
          startAt: startAt.toISOString(),
          endAt: endAt.toISOString(),
        }),
      );
      return out(args.format, block, (data) => `Planned ${blockLine(data)}`);
    },
  );

  tool(
    "move_block",
    {
      title: "Move time block",
      description:
        "Move or resize a planned block: a new day (keeps the times and length), a new start (keeps the " +
        "length) and/or a new end (local HH:MM), or a new title.",
      inputSchema: {
        block: BlockId,
        date: PlanDate.optional().describe("New day YYYY-MM-DD."),
        start: Time.optional(),
        end: Time.optional(),
        title: z.string().trim().max(200).optional(),
        format,
      },
      annotations: WRITE,
    },
    async (args) => {
      const today = ctx().today;
      const all = await api.get<TimeBlock[]>("/blocks", {
        from: addLocalDays(today, -31),
        to: addLocalDays(today, 31),
      });
      const current = all.find((b) => b.id === args.block);
      if (!current) {
        throw new ToolError(`No block ${args.block} within a month of today. list_plan shows the blocks.`);
      }
      const day = args.date ?? planLocalDate(current.startAt, deps.timeZone);
      const length = Date.parse(current.endAt) - Date.parse(current.startAt);
      const startTime = args.start ?? toLocalTime(current.startAt, deps.timeZone);
      const startAt = localTimeToInstant(day, startTime, deps.timeZone);
      let endAt = args.end
        ? localTimeToInstant(day, args.end, deps.timeZone)
        : new Date(startAt.getTime() + length);
      if (endAt <= startAt) endAt = new Date(endAt.getTime() + 86_400_000);
      const block = await api.patch<TimeBlock>(
        `/blocks/${args.block}`,
        compact({ startAt: startAt.toISOString(), endAt: endAt.toISOString(), title: args.title }),
      );
      return out(args.format, block, (data) => `Moved ${blockLine(data)}`);
    },
  );

  tool(
    "delete_block",
    {
      title: "Delete time block",
      description: "Remove a planned time block from the planner (the todo itself stays).",
      inputSchema: { block: BlockId },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      await api.delete(`/blocks/${args.block}`);
      return `Deleted block ${args.block}.`;
    },
  );
}
