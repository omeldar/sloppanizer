import {
  type CreateFeedback,
  type CreateSpace,
  FeedbackResult,
  type NextItem,
  NextUp,
  Space,
  Todo,
  type TodoStatus,
  type UpdateSpace,
} from "@organizer/shared";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { api, apiVoid, currentSpace } from "./api.ts";
import { spaceBase } from "./entry.ts";

/** Shared projects and feedback. Managing them always talks to the account itself, never to a space. */

const spacesKey = ["spaces"] as const;

const personal = { personal: true } as const;

/** The shared projects this account can open. */
export const useSpaces = () =>
  useQuery({ queryKey: spacesKey, queryFn: () => api(z.array(Space), "/spaces", personal) });

/** The shared project this tab works in (no data in the account's own tabs). */
export function useCurrentSpace() {
  const id = currentSpace();
  return useQuery({
    queryKey: [...spacesKey, id],
    queryFn: () => api(Space, `/spaces/${id}`, personal),
    enabled: id !== null,
  });
}

/** The address of a shared project (a full page load: its own cache, its own data). */
export const spaceHref = (username: string, space: Pick<Space, "id" | "projectSlug">): string =>
  `${spaceBase(username, space.id)}/${space.projectSlug ? `projects/${encodeURIComponent(space.projectSlug)}` : ""}`;

export function useCreateSpace() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSpace) => api(Space, "/spaces", { method: "POST", body: input, ...personal }),
    onSuccess: () => client.invalidateQueries({ queryKey: spacesKey }),
  });
}

export function useUpdateSpace(id: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSpace) =>
      api(Space, `/spaces/${id}`, { method: "PATCH", body: input, ...personal }),
    onSuccess: () => client.invalidateQueries({ queryKey: spacesKey }),
  });
}

export function useAddSpaceMember(id: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (username: string) =>
      api(Space, `/spaces/${id}/members`, { method: "POST", body: { username }, ...personal }),
    onSuccess: () => client.invalidateQueries({ queryKey: spacesKey }),
  });
}

export function useRemoveSpaceMember(id: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (accountId: number) =>
      apiVoid(`/spaces/${id}/members/${accountId}`, { method: "DELETE", ...personal }),
    onSuccess: () => client.invalidateQueries({ queryKey: spacesKey }),
  });
}

export function useDeleteSpace(id: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiVoid(`/spaces/${id}`, { method: "DELETE", ...personal }),
    onSuccess: () => client.invalidateQueries({ queryKey: spacesKey }),
  });
}

export const useSendFeedback = () =>
  useMutation({
    mutationFn: (input: CreateFeedback) =>
      api(FeedbackResult, "/feedback", { method: "POST", body: input, ...personal }),
  });

/** A todo of a shared project that is assigned to you, as your own Next up lists it. */
export interface AssignedItem {
  space: Space;
  item: NextItem;
}

const assignedKey = ["assigned"] as const;

/**
 * Todos assigned to you in your shared projects, ranked like Next up (one ranking per project, merged by
 * score: the same scoring on the same day). Only in your own tab; a shared project's tab shows its own.
 */
export function useAssignedToMe() {
  const inOwnTab = currentSpace() === null;
  const spaces = useSpaces();
  const list = inOwnTab ? (spaces.data ?? []) : [];
  const results = useQueries({
    queries: list.map((space) => ({
      queryKey: [...assignedKey, space.id],
      queryFn: () => api(NextUp, "/next", { query: { assignee: "me", limit: 50 }, space: space.id }),
    })),
  });
  const items: AssignedItem[] = results
    .flatMap((result, i) => {
      const space = list[i];
      return space && result.data ? result.data.items.map((item) => ({ space, item })) : [];
    })
    .toSorted((a, b) => b.item.score - a.item.score);
  return { items, isPending: inOwnTab && (spaces.isPending || results.some((r) => r.isPending)) };
}

/** A todo's address inside its shared project (opens that project's tab). */
export const sharedTodoHref = (username: string, spaceId: number, todoId: number): string =>
  `${spaceBase(username, spaceId)}/todos/${todoId}`;

/** Marks a todo of a shared project done or open again from your own tab. */
export function useSetSharedStatus() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ spaceId, todoId, status }: { spaceId: number; todoId: number; status: TodoStatus }) =>
      api(Todo, `/todos/${todoId}`, { method: "PATCH", body: { status }, space: spaceId }),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: assignedKey }),
        client.invalidateQueries({ queryKey: spacesKey }),
      ]),
  });
}
