import { API_PREFIX, CreatePersonTag, IdParams, PersonTag, UpdatePersonTag } from "@organizer/shared";
import { z } from "zod";
import {
  createPersonTag,
  deletePersonTag,
  listPersonTags,
  updatePersonTag,
} from "../services/person-tags.ts";
import { type App, ctxOf, type Deps } from "./types.ts";

export function personTagRoutes(app: App, deps: Deps): void {
  const tags = ["people"];
  app.get(
    `${API_PREFIX}/person-tags`,
    {
      schema: {
        tags,
        summary: "Person tags with their number of people, by name",
        response: { 200: z.array(PersonTag) },
      },
    },
    async (request) => listPersonTags(ctxOf(request, deps)),
  );
  app.post(
    `${API_PREFIX}/person-tags`,
    {
      schema: {
        tags,
        summary: "Create a person tag (409 with the existing one when the name is taken)",
        body: CreatePersonTag,
        response: { 201: PersonTag },
      },
    },
    async (request, reply) => reply.status(201).send(createPersonTag(ctxOf(request, deps), request.body)),
  );
  app.patch(
    `${API_PREFIX}/person-tags/:id`,
    { schema: { tags, params: IdParams, body: UpdatePersonTag, response: { 200: PersonTag } } },
    async (request) => updatePersonTag(ctxOf(request, deps), request.params.id, request.body),
  );
  app.delete(
    `${API_PREFIX}/person-tags/:id`,
    { schema: { tags, summary: "Delete a person tag (removed from everyone)", params: IdParams } },
    async (request, reply) => {
      deletePersonTag(ctxOf(request, deps), request.params.id);
      return reply.status(204).send();
    },
  );
}
