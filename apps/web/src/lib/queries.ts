import {
  Activity,
  ApiToken,
  BackupFile,
  Comment,
  CreatedToken,
  type CreateLabel,
  type CreateNote,
  type CreatePerson,
  type CreatePersonTag,
  type CreateProject,
  type CreateTodo,
  type CreateToken,
  type BulkPatch,
  BulkUpdateResult,
  FolderExport,
  RestorePreview,
  RestoreResult,
  Label,
  Me,
  NextUp,
  type NextMode,
  Note,
  NotePage,
  PeopleStats,
  Person,
  PersonStatDetail,
  PersonTag,
  Project,
  SearchResult,
  Settings,
  Stats,
  Team,
  Todo,
  TodoPage,
  Topic,
  type UpdateLabel,
  type UpdateNote,
  type UpdatePerson,
  type UpdatePersonTag,
  type UpdateProject,
  type UpdateTodo,
} from "@organizer/shared";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { api, apiVoid } from "./api.ts";

/** Query keys. Every todo change invalidates the derived lists through `invalidateTodoViews`. */
export const keys = {
  me: ["me"] as const,
  stats: ["stats"] as const,
  projects: ["projects"] as const,
  labels: ["labels"] as const,
  people: (query: PeopleParams) => ["people", query] as const,
  person: (id: number) => ["person", id] as const,
  topics: (q: string) => ["topics", q] as const,
  teams: ["teams"] as const,
  personTags: ["personTags"] as const,
  todos: (query: TodoListParams) => ["todos", query] as const,
  todo: (id: number) => ["todo", id] as const,
  activity: (todoId: number) => ["activity", todoId] as const,
  next: (query: NextParams) => ["next", query] as const,
  notes: (query: NoteListParams) => ["notes", query] as const,
  note: (id: number) => ["note", id] as const,
  search: (query: SearchParams) => ["search", query] as const,
  tokens: ["tokens"] as const,
  settings: ["settings"] as const,
  folderExports: ["folderExports"] as const,
  backups: ["backups"] as const,
  // Under "stats", so todo changes (invalidateTodoViews) refresh them too.
  peopleStats: (query: PeopleStatsParams) => ["stats", "people", query] as const,
  personStats: (id: number, query: PersonStatsParams) => ["stats", "person", id, query] as const,
};

export interface PersonStatsParams {
  /** Inclusive created dates (YYYY-MM-DD). */
  from?: string;
  to?: string;
  topic?: readonly string[];
  tag?: readonly string[];
  team?: string;
  label?: readonly string[];
  projectId?: number | "inbox";
}

export interface PeopleStatsParams extends PersonStatsParams {
  role?: "requester" | "contact";
  sort?: "total" | "open" | "done" | "speed" | "recent" | "name";
  limit?: number;
}

export interface PeopleParams {
  q?: string;
  /** Topic names, all must match. */
  topic?: readonly string[];
  team?: string;
  /** Person tag names, all must match. */
  tag?: readonly string[];
  kind?: "requester" | "contact";
  sort?: "name" | "requested" | "contact" | "recent";
}

export interface NoteListParams {
  projectId?: number | "none";
  pinned?: "true" | "false";
  q?: string;
  limit?: number;
}

export interface SearchParams {
  q: string;
  kinds?: readonly ("todo" | "note" | "comment" | "person")[];
  limit?: number;
}

export interface TodoListParams {
  status?: string;
  projectId?: number | "inbox";
  label?: readonly string[];
  personId?: number;
  personRole?: "requester" | "contact" | "any";
  /** Children of this todo, or "none" for top-level todos only. */
  parentId?: number | "none";
  q?: string;
  /** Inclusive calendar dates (YYYY-MM-DD). */
  plannedFrom?: string;
  plannedTo?: string;
  /** "true": only todos without a planned day. */
  unplanned?: "true";
  /** Done todos finished on or after this day; other statuses are not affected. */
  doneAfter?: string;
  sort?: "created" | "updated" | "due" | "priority" | "position";
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface NextParams {
  mode: NextMode;
  projectId?: number | "inbox";
  label?: readonly string[];
}

export const useMe = () => useQuery({ queryKey: keys.me, queryFn: () => api(Me, "/me") });
export const useStats = () => useQuery({ queryKey: keys.stats, queryFn: () => api(Stats, "/stats") });
export const useProjects = () =>
  useQuery({ queryKey: keys.projects, queryFn: () => api(z.array(Project), "/projects") });
export const useLabels = () =>
  useQuery({ queryKey: keys.labels, queryFn: () => api(z.array(Label), "/labels") });
/** Empty values are left out, so `{ q: "" }` and `{}` share one cache entry. */
function compact<T extends object>(params: T): T {
  return Object.fromEntries(
    Object.entries(params).filter(
      ([, value]) => value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0),
    ),
  ) as T;
}

export const usePeople = (params: PeopleParams = {}) => {
  const query = compact(params);
  return useQuery({
    queryKey: keys.people(query),
    queryFn: () => api(z.array(Person), "/people", { query: { ...query } }),
    placeholderData: (previous) => previous,
  });
};

export const usePerson = (id: number) =>
  useQuery({
    queryKey: keys.person(id),
    queryFn: () => api(Person, `/people/${id}`),
    enabled: Number.isInteger(id) && id > 0,
  });

export const useTopics = (q: string, enabled = true) =>
  useQuery({
    queryKey: keys.topics(q),
    queryFn: () => api(z.array(Topic), "/topics", { query: { q: q || undefined, limit: 20 } }),
    placeholderData: (previous) => previous,
    enabled,
  });

export const useTeams = () => useQuery({ queryKey: keys.teams, queryFn: () => api(z.array(Team), "/teams") });

export const usePersonTags = () =>
  useQuery({ queryKey: keys.personTags, queryFn: () => api(z.array(PersonTag), "/person-tags") });

export const useActivity = (todoId: number) =>
  useQuery({ queryKey: keys.activity(todoId), queryFn: () => api(Activity, `/todos/${todoId}/activity`) });

export const useNotes = (params: NoteListParams) => {
  const query = compact(params);
  return useQuery({
    queryKey: keys.notes(query),
    queryFn: () => api(NotePage, "/notes", { query: { ...query } }),
    placeholderData: (previous) => previous,
  });
};

export const useNote = (id: number) =>
  useQuery({
    queryKey: keys.note(id),
    queryFn: () => api(Note, `/notes/${id}`),
    enabled: Number.isInteger(id) && id > 0,
  });

export const useSearch = (params: SearchParams, enabled = true) =>
  useQuery({
    queryKey: keys.search(params),
    queryFn: () => api(SearchResult, "/search", { query: { ...params } }),
    placeholderData: (previous) => previous,
    enabled: enabled && params.q.trim().length > 0,
  });

export const usePeopleStats = (params: PeopleStatsParams | undefined) => {
  const query = compact(params ?? {});
  return useQuery({
    queryKey: keys.peopleStats(query),
    queryFn: () => api(PeopleStats, "/stats/people", { query: { ...query } }),
    placeholderData: (previous) => previous,
    enabled: params !== undefined,
  });
};

export const usePersonStats = (id: number, params: PersonStatsParams = {}) => {
  const query = compact(params);
  return useQuery({
    queryKey: keys.personStats(id, query),
    queryFn: () => api(PersonStatDetail, `/stats/people/${id}`, { query: { ...query } }),
    enabled: Number.isInteger(id) && id > 0,
  });
};

export const useTodos = (params: TodoListParams, enabled = true) =>
  useQuery({
    queryKey: keys.todos(params),
    queryFn: () => api(TodoPage, "/todos", { query: { ...params } }),
    enabled,
  });

export const useTodo = (id: number, enabled = true) =>
  useQuery({
    queryKey: keys.todo(id),
    queryFn: () => api(Todo, `/todos/${id}`),
    enabled: enabled && Number.isInteger(id) && id > 0,
  });

export const useNext = (params: NextParams) =>
  useQuery({
    queryKey: keys.next(params),
    queryFn: () => api(NextUp, "/next", { query: { ...params } }),
    placeholderData: (previous) => previous,
  });

/** Lists, counts and the status bar all derive from todos; refresh them after any change. */
export function invalidateTodoViews(client: QueryClient): Promise<void> {
  return client.invalidateQueries({
    predicate: (query) =>
      ["todos", "todo", "activity", "next", "stats", "projects", "people", "person", "search"].includes(
        String(query.queryKey[0]),
      ),
  });
}

export function useCreateTodo() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTodo) => api(Todo, "/todos", { method: "POST", body: input }),
    onSuccess: (todo) => {
      client.setQueryData(keys.todo(todo.id), todo);
      return invalidateTodoViews(client);
    },
  });
}

export function useUpdateTodo() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: UpdateTodo }) =>
      api(Todo, `/todos/${id}`, { method: "PATCH", body: patch }),
    onSuccess: (todo) => {
      client.setQueryData(keys.todo(todo.id), todo);
      return invalidateTodoViews(client);
    },
  });
}

/** Ticks one task list line; `text` is what the user saw, so a changed checklist answers 409. */
export function useToggleChecklist(todoId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { index: number; checked: boolean; text: string }) =>
      api(Todo, `/todos/${todoId}/checklist`, { method: "POST", body: input }),
    onSuccess: (todo) => {
      client.setQueryData(keys.todo(todo.id), todo);
      return invalidateTodoViews(client);
    },
  });
}

/** The direct children of a todo, in their order. */
export const childrenParams = (parentId: number): TodoListParams => ({
  parentId,
  status: "all",
  sort: "position",
  order: "asc",
  limit: 200,
});

/** One patch for many todos (all or nothing). */
export function useBulkUpdate() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { ids: number[]; patch: BulkPatch }) =>
      api(BulkUpdateResult, "/todos/bulk", { method: "POST", body: input }),
    onSuccess: () => invalidateTodoViews(client),
  });
}

/** Links between todos change both todos, Next up (blocked ones leave the ranking) and lists. */
export function useAddLinks(todoId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (links: { kind: "blocks" | "blocked_by" | "relates"; todoId: number }[]) =>
      api(Todo, `/todos/${todoId}/links`, { method: "POST", body: { links } }),
    onSuccess: (todo) => {
      client.setQueryData(keys.todo(todo.id), todo);
      return invalidateTodoViews(client);
    },
  });
}

export function useRemoveLink(todoId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ otherId, kind }: { otherId: number; kind: "blocks" | "blocked_by" | "relates" }) =>
      apiVoid(`/todos/${todoId}/links/${otherId}`, { method: "DELETE", query: { kind } }),
    onSuccess: () => invalidateTodoViews(client),
  });
}

/** Creates child todos in the given order after the last child. */
export function useAddSubtasks(todoId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (titles: string[]) =>
      api(z.array(Todo), `/todos/${todoId}/subtasks`, { method: "POST", body: { titles } }),
    onSuccess: () => invalidateTodoViews(client),
  });
}

export function useDeleteTodo() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiVoid(`/todos/${id}`, { method: "DELETE" }),
    onSuccess: (_void, id) => {
      client.removeQueries({ queryKey: keys.todo(id) });
      return invalidateTodoViews(client);
    },
  });
}

export function useCreateProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProject) => api(Project, "/projects", { method: "POST", body: input }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.projects }),
  });
}

export function useUpdateProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: UpdateProject }) =>
      api(Project, `/projects/${id}`, { method: "PATCH", body: patch }),
    onSuccess: () => invalidateTodoViews(client),
  });
}

/** Label changes show on every todo, so todo views refresh too. */
function useLabelMutation<TInput>(fn: (input: TInput) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: keys.labels });
      await invalidateTodoViews(client);
    },
  });
}

export const useCreateLabel = () =>
  useLabelMutation((input: CreateLabel) => api(Label, "/labels", { method: "POST", body: input }));
export const useUpdateLabel = () =>
  useLabelMutation(({ id, patch }: { id: number; patch: UpdateLabel }) =>
    api(Label, `/labels/${id}`, { method: "PATCH", body: patch }),
  );
export const useDeleteLabel = () =>
  useLabelMutation((id: number) => apiVoid(`/labels/${id}`, { method: "DELETE" }));

/** People show inside todos, and their topics, teams and tags feed the filters. */
export function invalidatePeopleViews(client: QueryClient): Promise<void> {
  return client.invalidateQueries({
    predicate: (query) =>
      ["people", "person", "topics", "teams", "personTags", "todos", "todo", "search"].includes(
        String(query.queryKey[0]),
      ),
  });
}

function usePersonMutation<TInput, TOutput>(fn: (input: TInput) => Promise<TOutput>) {
  const client = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => invalidatePeopleViews(client) });
}

export const useCreatePerson = () =>
  usePersonMutation((input: CreatePerson) => api(Person, "/people", { method: "POST", body: input }));
export const useUpdatePerson = () =>
  usePersonMutation(({ id, patch }: { id: number; patch: UpdatePerson }) =>
    api(Person, `/people/${id}`, { method: "PATCH", body: patch }),
  );
export const useDeletePerson = () =>
  usePersonMutation((id: number) => apiVoid(`/people/${id}`, { method: "DELETE" }));

export const useRenameTopic = () =>
  usePersonMutation(({ id, name }: { id: number; name: string }) =>
    api(Topic, `/topics/${id}`, { method: "PATCH", body: { name } }),
  );
export const useDeleteTopic = () =>
  usePersonMutation((id: number) => apiVoid(`/topics/${id}`, { method: "DELETE" }));

export const useCreatePersonTag = () =>
  usePersonMutation((input: CreatePersonTag) =>
    api(PersonTag, "/person-tags", { method: "POST", body: input }),
  );
export const useUpdatePersonTag = () =>
  usePersonMutation(({ id, patch }: { id: number; patch: UpdatePersonTag }) =>
    api(PersonTag, `/person-tags/${id}`, { method: "PATCH", body: patch }),
  );
export const useDeletePersonTag = () =>
  usePersonMutation((id: number) => apiVoid(`/person-tags/${id}`, { method: "DELETE" }));

/** A comment changes the thread, the todo's comment count and search. */
function useCommentMutation<TInput, TOutput>(fn: (input: TInput) => Promise<TOutput>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () =>
      client.invalidateQueries({
        predicate: (query) =>
          ["activity", "todo", "todos", "next", "search"].includes(String(query.queryKey[0])),
      }),
  });
}

export const useCreateComment = (todoId: number) =>
  useCommentMutation((bodyMd: string) =>
    api(Comment, `/todos/${todoId}/comments`, { method: "POST", body: { bodyMd } }),
  );
export const useUpdateComment = () =>
  useCommentMutation(({ id, bodyMd }: { id: number; bodyMd: string }) =>
    api(Comment, `/comments/${id}`, { method: "PATCH", body: { bodyMd } }),
  );
export const useDeleteComment = () =>
  useCommentMutation((id: number) => apiVoid(`/comments/${id}`, { method: "DELETE" }));

function invalidateNotes(client: QueryClient) {
  return client.invalidateQueries({
    predicate: (query) => ["notes", "search"].includes(String(query.queryKey[0])),
  });
}

export function useCreateNote() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateNote) => api(Note, "/notes", { method: "POST", body: input }),
    onSuccess: (note) => {
      client.setQueryData(keys.note(note.id), note);
      return invalidateNotes(client);
    },
  });
}

export function useUpdateNote() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: UpdateNote }) =>
      api(Note, `/notes/${id}`, { method: "PATCH", body: patch }),
    onSuccess: (note) => {
      client.setQueryData(keys.note(note.id), note);
      return invalidateNotes(client);
    },
  });
}

export function useDeleteNote() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiVoid(`/notes/${id}`, { method: "DELETE" }),
    onSuccess: (_void, id) => {
      client.removeQueries({ queryKey: keys.note(id) });
      return invalidateNotes(client);
    },
  });
}

export const useTokens = () =>
  useQuery({ queryKey: keys.tokens, queryFn: () => api(z.array(ApiToken), "/tokens") });

/**
 * Creates a token. Not a mutation hook on purpose: the raw value must stay in the caller's component state,
 * never in the query or mutation cache.
 */
export async function createToken(client: QueryClient, input: CreateToken): Promise<CreatedToken> {
  const created = await api(CreatedToken, "/tokens", { method: "POST", body: input });
  void client.invalidateQueries({ queryKey: keys.tokens });
  return created;
}

export function useRevokeToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiVoid(`/tokens/${id}`, { method: "DELETE" }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.tokens }),
  });
}

/** Session only: export folder, data dir, last exports. */
export const useSettings = (enabled = true) =>
  useQuery({ queryKey: keys.settings, queryFn: () => api(Settings, "/settings"), enabled });

/** The zips in the export folder, newest first. */
export const useFolderExports = (enabled = true) =>
  useQuery({
    queryKey: keys.folderExports,
    queryFn: () => api(z.array(FolderExport), "/export/folder"),
    enabled,
  });

/** Safety copies written before restores, newest first. */
export const useBackups = (enabled = true) =>
  useQuery({
    queryKey: keys.backups,
    queryFn: () => api(z.array(BackupFile), "/restore/backups"),
    enabled,
  });

/** Writes an export zip into the export folder (a plain function so the palette can call it and close). */
export async function writeFolderExport(client: QueryClient): Promise<FolderExport> {
  const written = await api(FolderExport, "/export/folder", { method: "POST" });
  void client.invalidateQueries({
    predicate: (query) => ["settings", "folderExports", "stats"].includes(String(query.queryKey[0])),
  });
  return written;
}

export function useWriteFolderExport() {
  const client = useQueryClient();
  return useMutation({ mutationFn: () => writeFolderExport(client) });
}

/** Uploads an export zip to check it; the server keeps it staged for an hour. */
export const uploadRestore = (file: Blob, name: string) =>
  api(RestorePreview, "/restore", { method: "POST", raw: file, query: { name } });

export const cancelRestore = (uploadId: string) => apiVoid(`/restore/${uploadId}`, { method: "DELETE" });

export const applyRestore = (uploadId: string) =>
  api(RestoreResult, `/restore/${uploadId}/apply`, { method: "POST", body: { confirm: "replace" } });
