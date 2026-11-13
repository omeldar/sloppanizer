import { API_PREFIX, CreatePerson, IdParams, PeopleQuery, Person, UpdatePerson } from "@organizer/shared";
import { z } from "zod";
import { createPerson, deletePerson, getPerson, listPeople, updatePerson } from "../services/people.ts";
import { type App, ctxOf, type Deps } from "./types.ts";

export function peopleRoutes(app: App, deps: Deps): void {
  const tags = ["people"];
  app.get(
    `${API_PREFIX}/people`,
    {
      schema: {
        tags,
        summary: "People with topics, tags and todo counts; filters q, topic, team, tag, kind; sort",
        querystring: PeopleQuery,
        response: { 200: z.array(Person) },
      },
    },
    async (request) => listPeople(ctxOf(request, deps), request.query),
  );
  app.post(
    `${API_PREFIX}/people`,
    {
      schema: {
        tags,
        summary: "Create a person (409 with the existing one for a namesake unless allowDuplicate)",
        body: CreatePerson,
        response: { 201: Person },
      },
    },
    async (request, reply) => reply.status(201).send(createPerson(ctxOf(request, deps), request.body)),
  );
  app.get(
    `${API_PREFIX}/people/:id`,
    { schema: { tags, params: IdParams, response: { 200: Person } } },
    async (request) => getPerson(ctxOf(request, deps), request.params.id),
  );
  app.patch(
    `${API_PREFIX}/people/:id`,
    { schema: { tags, params: IdParams, body: UpdatePerson, response: { 200: Person } } },
    async (request) => updatePerson(ctxOf(request, deps), request.params.id, request.body),
  );
  app.delete(
    `${API_PREFIX}/people/:id`,
    {
      schema: { tags, summary: "Delete a person (409 while linked to todos in any role)", params: IdParams },
    },
    async (request, reply) => {
      deletePerson(ctxOf(request, deps), request.params.id);
      return reply.status(204).send();
    },
  );
}
