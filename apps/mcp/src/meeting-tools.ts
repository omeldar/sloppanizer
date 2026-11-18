import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import {
  CalendarDate,
  formatDate,
  type Meeting,
  type MeetingNote,
  type Note,
  type Standup,
  StandupKind,
} from "@organizer/shared";
import { z } from "zod";
import { type Api, ToolError } from "./api.ts";
import { meetingLine, standupText } from "./format.ts";

/** Registers a tool whose handler returns text (the helper of tools.ts). */
export type ToolRegistrar = <S extends z.ZodRawShape>(
  name: string,
  config: { title: string; description: string; inputSchema: S; annotations: ToolAnnotations },
  run: (args: z.infer<z.ZodObject<S>>) => Promise<string>,
) => void;

const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const format = z
  .enum(["text", "json"])
  .default("text")
  .describe("text (default): compact lines. json: the full API objects.");

const MeetingInput = z
  .union([z.number().int().positive(), z.string().trim().min(1)])
  .describe('Meeting id from list_meetings, or its name (e.g. "Weekly Standup").');

const OnInput = CalendarDate.optional().describe(
  "The meeting date YYYY-MM-DD (default: its next date, today included).",
);

/** Finds a meeting by id, by its exact name (any case) or by the only name that contains the text. */
async function resolveMeeting(api: Api, input: number | string): Promise<Meeting> {
  if (typeof input === "number") return api.get<Meeting>(`/meetings/${input}`);
  const meetings = await api.get<Meeting[]>("/meetings");
  const key = input.toLowerCase();
  const exact = meetings.filter((m) => m.name.toLowerCase() === key);
  const matches = exact.length > 0 ? exact : meetings.filter((m) => m.name.toLowerCase().includes(key));
  if (matches.length === 1 && matches[0]) return matches[0];
  const list = meetings.map((m) => `- ${m.id} ${m.name}`).join("\n") || "(none)";
  throw new ToolError(
    matches.length === 0
      ? `No meeting named "${input}". The meetings:\n${list}`
      : `Several meetings match "${input}"; pass the id:\n${list}`,
  );
}

function standupOnly(meeting: Meeting): void {
  if (meeting.type !== "standup")
    throw new ToolError(`${meeting.name} is not a standup, so it has no list. The user can change its type.`);
}

/** Meetings (list_meetings, standup_list, mark_said, meeting_note). Creating meetings stays in the web app. */
export function registerMeetingTools(tool: ToolRegistrar, deps: { api: Api; timeZone: string }): void {
  const { api, timeZone } = deps;

  tool(
    "list_meetings",
    {
      title: "List meetings",
      description:
        "The user's meetings with their repeat, next date and, for standups, how many items are still to say. " +
        "Meetings are created and changed in the web app.",
      inputSchema: { format },
      annotations: READ,
    },
    async (args) => {
      const meetings = await api.get<Meeting[]>("/meetings");
      if (args.format === "json") return JSON.stringify(meetings);
      return meetings.length === 0
        ? "No meetings yet."
        : meetings.map((m) => meetingLine(m, timeZone)).join("\n");
    },
  );

  tool(
    "standup_list",
    {
      title: "Standup list",
      description:
        "What the user has not said yet at a standup: done, started, updated and blocked todos since the " +
        "window start, with what changed and the last comment, grouped by kind and newest first; also what " +
        "was said on that date. Use it to prepare the standup or to sum it up.",
      inputSchema: {
        meeting: MeetingInput,
        kinds: z
          .array(StandupKind)
          .min(1)
          .optional()
          .describe("Only these kinds: done, started, updated, blocked."),
        on: OnInput,
        format,
      },
      annotations: READ,
    },
    async (args) => {
      const meeting = await resolveMeeting(api, args.meeting);
      standupOnly(meeting);
      const standup = await api.get<Standup>(`/meetings/${meeting.id}/standup`, {
        on: args.on,
        kind: args.kinds?.join(","),
      });
      return args.format === "json" ? JSON.stringify(standup) : standupText(standup, meeting.name, timeZone);
    },
  );

  tool(
    "mark_said",
    {
      title: "Mark as said",
      description:
        "Tick todos of a standup list as said (or dismiss them: they leave the list without counting as said). " +
        "A todo shows again when it gets new updates. Only todos that are on the list (standup_list) can be marked.",
      inputSchema: {
        meeting: MeetingInput,
        todos: z
          .array(z.number().int().positive())
          .min(1)
          .max(200)
          .describe("Todo ids, the numbers after #."),
        dismiss: z.boolean().default(false).describe("true: dismiss instead of said."),
        on: OnInput,
      },
      annotations: WRITE,
    },
    async (args) => {
      const meeting = await resolveMeeting(api, args.meeting);
      standupOnly(meeting);
      const shown = await api.get<Standup>(`/meetings/${meeting.id}/standup`, { on: args.on });
      const todos = [...new Set(args.todos)];
      const items = new Map(shown.items.map((item) => [item.todo.id, item]));
      const missing = todos.filter((id) => !items.has(id));
      if (missing.length > 0) {
        throw new ToolError(
          `Not on the list of ${meeting.name}: ${missing.map((id) => `#${id}`).join(", ")} (nothing new to say). ` +
            "standup_list shows the list.",
        );
      }
      const kind = args.dismiss ? "dismissed" : "said";
      // The time each item showed covers its activity up to then; anything newer brings it back.
      const after = await api.post<Standup>(`/meetings/${meeting.id}/standup/marks`, {
        on: shown.on,
        marks: todos.map((todoId) => ({ todoId, kind, coveredUntil: items.get(todoId)?.at })),
      });
      const left = after.counts.done + after.counts.started + after.counts.updated + after.counts.blocked;
      const verb = args.dismiss ? "Dismissed" : "Said";
      return `${verb} ${todos.map((id) => `#${id}`).join(", ")} at ${meeting.name} on ${formatDate(shown.on)}. ${left} left to say.`;
    },
  );

  tool(
    "meeting_note",
    {
      title: "Add to a meeting note",
      description:
        "Write into the note of a meeting date (what was heard or said): the text is added at the end of the " +
        "date's note, which is created first when the date has none. get_note reads it.",
      inputSchema: {
        meeting: MeetingInput,
        on: OnInput,
        text: z.string().trim().min(1).max(200_000).describe("Markdown to add at the end."),
      },
      annotations: WRITE,
    },
    async (args) => {
      const meeting = await resolveMeeting(api, args.meeting);
      const on = args.on ?? meeting.next?.occursOn;
      if (!on) throw new ToolError(`${meeting.name} has no next date; pass the date (on).`);
      const notes = await api.get<MeetingNote[]>(`/meetings/${meeting.id}/notes`);
      const noteId =
        notes.find((n) => n.on === on)?.note.id ??
        (await api.post<MeetingNote>(`/meetings/${meeting.id}/notes`, { on })).note.id;
      const note = await api.patch<Note>(`/notes/${noteId}`, { appendMd: args.text });
      return `Added to note ${note.id} "${note.title}" of ${meeting.name} on ${formatDate(on)}.`;
    },
  );
}
