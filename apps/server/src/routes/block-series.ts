import {
  API_PREFIX,
  BlockDateChange,
  BlockDateParams,
  BlockOccurrence,
  BlockOccurrenceQuery,
  BlockSeries,
  CreateBlockSeries,
  IdParams,
  RecurringTodo,
} from "@organizer/shared";
import { z } from "zod";
import {
  changeRepeatPlanDate,
  createRepeatPlan,
  deleteRepeatPlan,
  getRepeatPlan,
  listRecurring,
  listRepeatOccurrences,
} from "../services/block-series.ts";
import { type App, ctxOf, type Deps } from "./types.ts";

/**
 * Repeating todos: the Recurring view, and planned time that repeats with a todo. `:id` is any todo of
 * the repeat; the planned time belongs to the repeat, not to one of its todos.
 */
export function blockSeriesRoutes(app: App, deps: Deps): void {
  const tags = ["planner"];
  app.get(
    `${API_PREFIX}/todos/recurring`,
    {
      schema: {
        tags: ["todos"],
        summary: "Every repeating todo once: its open todo, next date, history and planned time",
        response: { 200: z.array(RecurringTodo) },
      },
    },
    async (request) => listRecurring(ctxOf(request, deps)),
  );
  app.get(
    `${API_PREFIX}/blocks/series`,
    {
      schema: {
        tags,
        summary: "Planned dates of repeating todos that overlap the days from..to, by start",
        querystring: BlockOccurrenceQuery,
        response: { 200: z.array(BlockOccurrence) },
      },
    },
    async (request) => listRepeatOccurrences(ctxOf(request, deps), request.query),
  );
  app.get(
    `${API_PREFIX}/todos/:id/plan`,
    {
      schema: {
        tags,
        summary: "The planned time that repeats with a repeating todo (404 when it has none)",
        params: IdParams,
        response: { 200: BlockSeries },
      },
    },
    async (request) => getRepeatPlan(ctxOf(request, deps), request.params.id),
  );
  app.post(
    `${API_PREFIX}/todos/:id/plan`,
    {
      schema: {
        tags,
        summary: "Plan time that comes back with every date of the todo's repeat (schedule repeats only)",
        params: IdParams,
        body: CreateBlockSeries,
        response: { 201: BlockSeries },
      },
    },
    async (request, reply) =>
      reply.status(201).send(createRepeatPlan(ctxOf(request, deps), request.params.id, request.body)),
  );
  app.patch(
    `${API_PREFIX}/todos/:id/plan/:on`,
    {
      schema: {
        tags,
        summary: "Move or cancel one planned date: this one, this and following, or all",
        params: BlockDateParams,
        body: BlockDateChange,
        response: { 200: BlockSeries },
      },
    },
    async (request) =>
      changeRepeatPlanDate(ctxOf(request, deps), request.params.id, request.params.on, request.body),
  );
  app.delete(
    `${API_PREFIX}/todos/:id/plan`,
    { schema: { tags, summary: "Remove the planned time with all its dates", params: IdParams } },
    async (request, reply) => {
      deleteRepeatPlan(ctxOf(request, deps), request.params.id);
      return reply.status(204).send();
    },
  );
}
