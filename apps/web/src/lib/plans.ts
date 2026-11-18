import {
  type BlockDateChange,
  BlockOccurrence,
  BlockSeries,
  type CreateBlockSeries,
  RecurringTodo,
} from "@organizer/shared";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { api, apiVoid } from "./api.ts";

/**
 * Repeating todos: the Recurring view, and planned time that repeats with a todo. The planner's dates
 * live under "blocks", so whatever refreshes the planner refreshes them too.
 */
export const planKeys = {
  occurrences: (from: string, to: string) => ["blocks", "series", from, to] as const,
  plan: (todoId: number) => ["plan", todoId] as const,
  recurring: ["recurring"] as const,
};

export const useRepeatOccurrences = (from: string, to: string) =>
  useQuery({
    queryKey: planKeys.occurrences(from, to),
    queryFn: () => api(z.array(BlockOccurrence), "/blocks/series", { query: { from, to } }),
    placeholderData: (previous) => previous,
  });

/** The planned time of a repeating todo (any todo of the repeat), or null when it has none. */
export const useRepeatPlan = (todoId: number, enabled = true) =>
  useQuery({
    queryKey: planKeys.plan(todoId),
    queryFn: async () => {
      try {
        return await api(BlockSeries, `/todos/${todoId}/plan`);
      } catch (failure) {
        if ((failure as { status?: number }).status === 404) return null;
        throw failure;
      }
    },
    enabled,
  });

export const useRecurring = () =>
  useQuery({ queryKey: planKeys.recurring, queryFn: () => api(z.array(RecurringTodo), "/todos/recurring") });

function invalidatePlans(client: QueryClient): Promise<void> {
  return client.invalidateQueries({
    predicate: (query) => ["blocks", "plan", "recurring"].includes(String(query.queryKey[0])),
  });
}

function usePlanMutation<V, R>(run: (vars: V) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({ mutationFn: run, onSuccess: () => invalidatePlans(client) });
}

/** Plans time for a repeating todo that comes back with every date of its repeat. */
export const useCreateRepeatPlan = () =>
  usePlanMutation(({ todoId, span }: { todoId: number; span: CreateBlockSeries }) =>
    api(BlockSeries, `/todos/${todoId}/plan`, { method: "POST", body: span }),
  );

/** Moves or cancels one planned date (or this and following, or all); `on` is the original date. */
export const useChangeRepeatDate = () =>
  usePlanMutation(({ todoId, on, change }: { todoId: number; on: string; change: BlockDateChange }) =>
    api(BlockSeries, `/todos/${todoId}/plan/${on}`, { method: "PATCH", body: change }),
  );

/** Removes the planned time with all its dates; the todos stay. */
export const useDeleteRepeatPlan = () =>
  usePlanMutation((todoId: number) => apiVoid(`/todos/${todoId}/plan`, { method: "DELETE" }));
