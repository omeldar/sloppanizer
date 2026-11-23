import {
  type CreateFeedback,
  type CreateSpace,
  FeedbackResult,
  Space,
  type UpdateSpace,
} from "@organizer/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
