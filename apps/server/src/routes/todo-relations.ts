import {
  API_PREFIX,
  CreateLinks,
  CreateSubtasks,
  IdParams,
  LinkDeleteQuery,
  LinkParams,
  Todo,
  ToggleChecklist,
} from "@organizer/shared";
import { z } from "zod";
import { toggleChecklist } from "../services/checklist.ts";
import { addLinks, removeLink } from "../services/links.ts";
import { createSubtasks } from "../services/subtasks.ts";
import { actorOf, type App, type Deps } from "./types.ts";

/** Subtasks, links between todos and checklist items. */
export function todoRelationRoutes(app: App, deps: Deps): void {
  const tags = ["todos"];
  app.post(
    `${API_PREFIX}/todos/:id/subtasks`,
    {
      schema: {
        tags,
        summary: "Add subtasks in the given order (they take the parent's project)",
        params: IdParams,
        body: CreateSubtasks,
        response: { 201: z.array(Todo) },
      },
    },
    async (request, reply) =>
      reply.status(201).send(createSubtasks(deps, actorOf(request), request.params.id, request.body)),
  );
  app.post(
    `${API_PREFIX}/todos/:id/links`,
    {
      schema: {
        tags,
        summary: "Link todos (blocks, blocked_by, relates); existing links are kept",
        params: IdParams,
        body: CreateLinks,
        response: { 200: Todo },
      },
    },
    async (request) => addLinks(deps, actorOf(request), request.params.id, request.body),
  );
  app.delete(
    `${API_PREFIX}/todos/:id/links/:otherId`,
    { schema: { tags, summary: "Remove a link", params: LinkParams, querystring: LinkDeleteQuery } },
    async (request, reply) => {
      removeLink(deps, actorOf(request), request.params.id, request.params.otherId, request.query.kind);
      return reply.status(204).send();
    },
  );
  app.post(
    `${API_PREFIX}/todos/:id/checklist`,
    {
      schema: {
        tags,
        summary: "Check or uncheck a task list item of the description (409 when it changed)",
        params: IdParams,
        body: ToggleChecklist,
        response: { 200: Todo },
      },
    },
    async (request) => toggleChecklist(deps, actorOf(request), request.params.id, request.body),
  );
}
