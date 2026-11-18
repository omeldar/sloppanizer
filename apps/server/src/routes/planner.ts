import {
  AddUrls,
  API_PREFIX,
  CreateTimeBlock,
  IdParams,
  TimeBlock,
  TimeBlockQuery,
  Todo,
  UpdateTimeBlock,
  UpdateUrl,
  UrlParams,
} from "@organizer/shared";
import { z } from "zod";
import { createBlock, deleteBlock, listBlocks, updateBlock } from "../services/blocks.ts";
import { addUrls, deleteUrl, updateUrl } from "../services/urls.ts";
import { actorOf, type App, ctxOf, type Deps } from "./types.ts";

/** The planner's time blocks and the web links of todos. */
export function plannerRoutes(app: App, deps: Deps): void {
  const tags = ["planner"];
  app.get(
    `${API_PREFIX}/blocks`,
    {
      schema: {
        tags,
        summary: "Time blocks that overlap the days from..to (account time zone), by start",
        querystring: TimeBlockQuery,
        response: { 200: z.array(TimeBlock) },
      },
    },
    async (request) => listBlocks(ctxOf(request, deps), request.query),
  );
  app.post(
    `${API_PREFIX}/blocks`,
    {
      schema: {
        tags,
        summary: "Reserve time for a todo (todoId) or with a title",
        body: CreateTimeBlock,
        response: { 201: TimeBlock },
      },
    },
    async (request, reply) =>
      reply.status(201).send(createBlock(ctxOf(request, deps), actorOf(request), request.body)),
  );
  app.patch(
    `${API_PREFIX}/blocks/:id`,
    {
      schema: {
        tags,
        summary: "Move, resize or rename a time block",
        params: IdParams,
        body: UpdateTimeBlock,
        response: { 200: TimeBlock },
      },
    },
    async (request) => updateBlock(ctxOf(request, deps), actorOf(request), request.params.id, request.body),
  );
  app.delete(
    `${API_PREFIX}/blocks/:id`,
    { schema: { tags, summary: "Delete a time block", params: IdParams } },
    async (request, reply) => {
      deleteBlock(ctxOf(request, deps), request.params.id);
      return reply.status(204).send();
    },
  );

  const todoTags = ["todos"];
  app.post(
    `${API_PREFIX}/todos/:id/urls`,
    {
      schema: {
        tags: todoTags,
        summary: "Add web links to a todo (a URL it has already is skipped)",
        params: IdParams,
        body: AddUrls,
        response: { 200: Todo },
      },
    },
    async (request) => addUrls(ctxOf(request, deps), request.params.id, request.body.urls),
  );
  app.patch(
    `${API_PREFIX}/todos/:id/urls/:urlId`,
    {
      schema: {
        tags: todoTags,
        summary: "Change a web link or its label",
        params: UrlParams,
        body: UpdateUrl,
        response: { 200: Todo },
      },
    },
    async (request) => updateUrl(ctxOf(request, deps), request.params.id, request.params.urlId, request.body),
  );
  app.delete(
    `${API_PREFIX}/todos/:id/urls/:urlId`,
    {
      schema: {
        tags: todoTags,
        summary: "Remove a web link",
        params: UrlParams,
        response: { 200: Todo },
      },
    },
    async (request) => deleteUrl(ctxOf(request, deps), request.params.id, request.params.urlId),
  );
}
