import {
  type CreateLabel,
  type CreatePerson,
  type CreateProject,
  type CreateTodo,
  Label,
  Me,
  NextUp,
  type NextMode,
  Person,
  Project,
  Stats,
  Todo,
  TodoPage,
  type UpdateLabel,
  type UpdatePerson,
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
  people: (q?: string) => ["people", q ?? ""] as const,
  todos: (query: TodoListParams) => ["todos", query] as const,
  todo: (id: number) => ["todo", id] as const,
  next: (query: NextParams) => ["next", query] as const,
};

export interface TodoListParams {
  status?: string;
  projectId?: number | "inbox";
  label?: readonly string[];
  personId?: number;
  q?: string;
  sort?: "created" | "updated" | "due" | "priority" | "position";
  order?: "asc" | "desc";
  limit?: number;
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
export const usePeople = (q?: string) =>
  useQuery({
    queryKey: keys.people(q),
    queryFn: () => api(z.array(Person), "/people", { query: { q: q || undefined } }),
    placeholderData: (previous) => previous,
  });

export const useTodos = (params: TodoListParams, enabled = true) =>
  useQuery({
    queryKey: keys.todos(params),
    queryFn: () => api(TodoPage, "/todos", { query: { ...params } }),
    enabled,
  });

export const useTodo = (id: number) =>
  useQuery({
    queryKey: keys.todo(id),
    queryFn: () => api(Todo, `/todos/${id}`),
    enabled: Number.isInteger(id) && id > 0,
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
      ["todos", "todo", "next", "stats", "projects", "people"].includes(String(query.queryKey[0])),
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

function usePersonMutation<TInput, TOutput>(fn: (input: TInput) => Promise<TOutput>) {
  const client = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => invalidateTodoViews(client) });
}

export const useCreatePerson = () =>
  usePersonMutation((input: CreatePerson) => api(Person, "/people", { method: "POST", body: input }));
export const useUpdatePerson = () =>
  usePersonMutation(({ id, patch }: { id: number; patch: UpdatePerson }) =>
    api(Person, `/people/${id}`, { method: "PATCH", body: patch }),
  );
export const useDeletePerson = () =>
  usePersonMutation((id: number) => apiVoid(`/people/${id}`, { method: "DELETE" }));
