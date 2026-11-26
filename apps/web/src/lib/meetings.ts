import {
  addDays,
  type CreateMeetingInput,
  type MarkKind,
  Meeting,
  MeetingNote,
  MeetingOccurrence,
  MeetingTodo,
  MeetingTodos,
  type OccurrenceChange,
  type ScheduleChange,
  type Series,
  seriesDates,
  Standup,
  type StandupKind,
  Todo,
  TodoMeeting,
  type UpdateMeeting,
} from "@organizer/shared";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { api, apiVoid } from "./api.ts";
import { invalidateTodoViews, keys } from "./queries.ts";

/** Query keys of meetings. Every meeting change refreshes the list, the planner and the standup lists. */
export const meetingKeys = {
  all: ["meetings"] as const,
  meeting: (id: number) => ["meetings", id] as const,
  occurrences: (query: OccurrenceParams) => ["occurrences", query] as const,
  notes: (id: number) => ["meetingNotes", id] as const,
  standup: (id: number, on: string, kind: StandupKind | null) => ["standup", id, on, kind] as const,
  todos: (id: number) => ["meetingTodos", id] as const,
  todoMeetings: (todoId: number) => ["todoMeetings", todoId] as const,
};

export interface OccurrenceParams {
  from: string;
  to: string;
  meetingId?: number;
  /** Cancelled dates too. */
  cancelled?: "true";
}

const isId = (id: number) => Number.isInteger(id) && id > 0;

export const useMeetings = () =>
  useQuery({ queryKey: meetingKeys.all, queryFn: () => api(z.array(Meeting), "/meetings") });

export const useMeeting = (id: number) =>
  useQuery({
    queryKey: meetingKeys.meeting(id),
    queryFn: () => api(Meeting, `/meetings/${id}`),
    enabled: isId(id),
  });

/** Meeting dates that overlap the days from..to (at most 62 days). */
export const useOccurrences = (params: OccurrenceParams, enabled = true) =>
  useQuery({
    queryKey: meetingKeys.occurrences(params),
    queryFn: () => api(z.array(MeetingOccurrence), "/meetings/occurrences", { query: { ...params } }),
    placeholderData: (previous) => previous,
    enabled,
  });

/** The notes of a meeting's dates, newest date first. */
export const useMeetingNotes = (id: number) =>
  useQuery({
    queryKey: meetingKeys.notes(id),
    queryFn: () => api(z.array(MeetingNote), `/meetings/${id}/notes`),
    enabled: isId(id),
  });

/** The standup list for a date; always fresh, because it is read during the meeting. */
export const useStandup = (id: number, on: string | null, kind: StandupKind | null) =>
  useQuery({
    queryKey: meetingKeys.standup(id, on ?? "", kind),
    queryFn: () =>
      api(Standup, `/meetings/${id}/standup`, { query: { on, kind: kind ? [kind] : undefined } }),
    enabled: isId(id) && on !== null,
    staleTime: 0,
    refetchOnWindowFocus: true,
    placeholderData: (previous, query) =>
      // Keep the list while another kind loads, never across meetings or dates.
      previous && query?.queryKey[1] === id && query.queryKey[2] === on ? previous : undefined,
  });

function invalidateMeetings(client: QueryClient): Promise<void> {
  return client.invalidateQueries({
    predicate: (query) =>
      // Stats count meeting time (also per person); a meeting's people can add someone to People.
      [
        "meetings",
        "occurrences",
        "standup",
        "meetingNotes",
        "meetingTodos",
        "todoMeetings",
        "stats",
        "people",
      ].includes(String(query.queryKey[0])),
  });
}

function useMeetingMutation<V, R>(run: (vars: V) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({ mutationFn: run, onSuccess: () => invalidateMeetings(client) });
}

export const useCreateMeeting = () =>
  useMeetingMutation((input: CreateMeetingInput) =>
    api(Meeting, "/meetings", { method: "POST", body: input }),
  );

export const useUpdateMeeting = () =>
  useMeetingMutation(({ id, patch }: { id: number; patch: UpdateMeeting }) =>
    api(Meeting, `/meetings/${id}`, { method: "PATCH", body: patch }),
  );

export const useDeleteMeeting = () =>
  useMeetingMutation((id: number) => apiVoid(`/meetings/${id}`, { method: "DELETE" }));

/** A new repeat from a date on ("following") or for the part that holds the date ("all"). */
export const useChangeSchedule = () =>
  useMeetingMutation(({ id, change }: { id: number; change: ScheduleChange }) =>
    api(Meeting, `/meetings/${id}/schedule`, { method: "PATCH", body: change }),
  );

/** Moves or cancels one date (or this and following, or all); `on` is the original date. */
export const useChangeOccurrence = () =>
  useMeetingMutation(({ id, on, change }: { id: number; on: string; change: OccurrenceChange }) =>
    api(Meeting, `/meetings/${id}/occurrences/${on}`, { method: "PATCH", body: change }),
  );

/** A new note for the date (no noteId) or an existing one linked to it; a new one shows in Notes too. */
export function useAddMeetingNote() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, on, noteId }: { id: number; on: string; noteId?: number }) =>
      api(MeetingNote, `/meetings/${id}/notes`, { method: "POST", body: { on, noteId } }),
    onSuccess: async () => {
      await invalidateMeetings(client);
      await client.invalidateQueries({
        predicate: (query) => ["notes", "search"].includes(String(query.queryKey[0])),
      });
    },
  });
}

/** Unlinks the note of a date; the note itself stays. */
export const useUnlinkMeetingNote = () =>
  useMeetingMutation(({ id, on }: { id: number; on: string }) =>
    apiVoid(`/meetings/${id}/notes/${on}`, { method: "DELETE" }),
  );

/** The todos added to a meeting by hand, with the day "Due at next meeting" sets. */
export const useMeetingTodos = (id: number) =>
  useQuery({
    queryKey: meetingKeys.todos(id),
    queryFn: () => api(MeetingTodos, `/meetings/${id}/todos`),
    enabled: isId(id),
  });

/** The meetings a todo was added to, the next one first. */
export const useTodoMeetings = (todoId: number) =>
  useQuery({
    queryKey: meetingKeys.todoMeetings(todoId),
    queryFn: () => api(z.array(TodoMeeting), `/todos/${todoId}/meetings`),
    enabled: isId(todoId),
  });

export interface MeetingTodoVars {
  meetingId: number;
  todoId: number;
}

/** Adds a todo to a meeting; it stays on every date until removed. Its due date stays. */
export const useAddMeetingTodo = () =>
  useMeetingMutation(({ meetingId, todoId }: MeetingTodoVars) =>
    api(MeetingTodo, `/meetings/${meetingId}/todos`, { method: "POST", body: { todoId } }),
  );

/** Takes a todo off a meeting; the todo stays. */
export const useRemoveMeetingTodo = () =>
  useMeetingMutation(({ meetingId, todoId }: MeetingTodoVars) =>
    apiVoid(`/meetings/${meetingId}/todos/${todoId}`, { method: "DELETE" }),
  );

/** "Due at next meeting": the todo's due date becomes the day of the meeting's next date. */
export function useDueAtNextMeeting() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ meetingId, todoId }: MeetingTodoVars) =>
      api(Todo, `/meetings/${meetingId}/todos/${todoId}/due`, { method: "POST" }),
    onSuccess: async (todo) => {
      client.setQueryData(keys.todo(todo.id), todo);
      await Promise.all([invalidateTodoViews(client), invalidateMeetings(client)]);
    },
  });
}

export interface MarkVars {
  meetingId: number;
  on: string;
  todoId: number;
  kind: MarkKind;
  /** The item's `at`: activity up to this time is covered by the mark. */
  coveredUntil: string;
}

/**
 * The standup lists of a meeting date in the cache (one per kind filter), changed in place, so a tick
 * or a dismiss shows at once. Returns the old lists to put back when the server refuses.
 */
function patchStandups(
  client: QueryClient,
  meetingId: number,
  on: string,
  change: (list: Standup) => Standup,
): [readonly unknown[], Standup | undefined][] {
  const filters = { queryKey: ["standup", meetingId, on] };
  const before = client.getQueriesData<Standup>(filters);
  client.setQueriesData<Standup>(filters, (list) => (list ? change(list) : list));
  return before;
}

/** The list without the todo, counted down; a said one goes on top of the said list. */
export function withMark(list: Standup, vars: Pick<MarkVars, "todoId" | "kind">, now: string): Standup {
  const item = list.items.find((i) => i.todo.id === vars.todoId);
  // The kind filter may hide the item; it still counts in its kind.
  const kind = item?.kind;
  const counts = { ...list.counts };
  if (kind) counts[kind] = Math.max(0, counts[kind] - 1);
  return {
    ...list,
    items: list.items.filter((i) => i.todo.id !== vars.todoId),
    counts,
    said:
      vars.kind === "said" && item
        ? [{ todo: item.todo, project: item.project, markedAt: now }, ...list.said]
        : list.said,
    dismissedCount: list.dismissedCount + (vars.kind === "dismissed" ? 1 : 0),
  };
}

/** Ticks (said) or dismisses one item; shows at once and puts the list back if the server refuses. */
export function useMark() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ meetingId, on, todoId, kind, coveredUntil }: MarkVars) =>
      api(Standup, `/meetings/${meetingId}/standup/marks`, {
        method: "POST",
        body: { on, marks: [{ todoId, kind, coveredUntil }] },
      }),
    onMutate: async (vars) => {
      await client.cancelQueries({ queryKey: ["standup", vars.meetingId, vars.on] });
      return patchStandups(client, vars.meetingId, vars.on, (list) =>
        withMark(list, vars, new Date().toISOString()),
      );
    },
    onError: (_error, _vars, before) => {
      for (const [key, data] of before ?? []) client.setQueryData(key, data);
    },
    onSettled: () => invalidateMeetings(client),
  });
}

/** Takes a said or dismissed mark back; the item comes back with the next answer. */
export function useUnmark() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ meetingId, on, todoId }: Pick<MarkVars, "meetingId" | "on" | "todoId">) =>
      apiVoid(`/meetings/${meetingId}/standup/marks/${on}/${todoId}`, { method: "DELETE" }),
    onMutate: async (vars) => {
      await client.cancelQueries({ queryKey: ["standup", vars.meetingId, vars.on] });
      return patchStandups(client, vars.meetingId, vars.on, (list) => ({
        ...list,
        said: list.said.filter((s) => s.todo.id !== vars.todoId),
      }));
    },
    onError: (_error, _vars, before) => {
      for (const [key, data] of before ?? []) client.setQueryData(key, data);
    },
    onSettled: () => invalidateMeetings(client),
  });
}

// ---------- dates of a meeting ----------

/** How far the date switcher looks for the next or previous date. */
const LOOK_DAYS = 400;

/** The meeting's original date after `on` (dir 1) or before it (dir -1), or null when there is none. */
export function stepMeetingDate(segments: readonly Series[], on: string, dir: 1 | -1): string | null {
  const found = segments.flatMap((segment) => {
    const dates =
      dir === 1
        ? seriesDates(segment, addDays(on, 1), addDays(on, LOOK_DAYS))
        : seriesDates(segment, addDays(on, -LOOK_DAYS), addDays(on, -1));
    const date = dir === 1 ? dates[0] : dates.at(-1);
    return date === undefined ? [] : [date];
  });
  if (found.length === 0) return null;
  return found.toSorted()[dir === 1 ? 0 : found.length - 1] ?? null;
}

/**
 * The date a meeting page opens on: the first date on or after today (like the server's standup
 * default), else the last one before it.
 */
export function defaultMeetingDate(segments: readonly Series[], today: string): string | null {
  return stepMeetingDate(segments, addDays(today, -1), 1) ?? stepMeetingDate(segments, today, -1);
}

/** The segment that holds an original date. */
export const segmentOf = (segments: readonly Series[], date: string): Series | undefined =>
  segments.find((s) => seriesDates(s, date, date).length > 0);
