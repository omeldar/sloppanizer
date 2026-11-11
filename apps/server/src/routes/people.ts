import { API_PREFIX, CreatePerson, IdParams, PeopleQuery, Person, UpdatePerson } from "@organizer/shared";
import { z } from "zod";
import {
  createPerson,
  deletePerson,
  getPersonRow,
  listPeople,
  toPerson,
  updatePerson,
} from "../services/people.ts";
import type { App, Deps } from "./types.ts";

export function peopleRoutes(app: App, deps: Deps): void {
  const tags = ["people"];
  app.get(
    `${API_PREFIX}/people`,
    {
      schema: {
        tags,
        summary: "People, by last name; q searches names and notes",
        querystring: PeopleQuery,
        response: { 200: z.array(Person) },
      },
    },
    async (request) => listPeople(deps.db, request.query.q),
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
    async (request, reply) => reply.status(201).send(createPerson(deps, request.body)),
  );
  app.get(
    `${API_PREFIX}/people/:id`,
    { schema: { tags, params: IdParams, response: { 200: Person } } },
    async (request) => toPerson(getPersonRow(deps.db, request.params.id)),
  );
  app.patch(
    `${API_PREFIX}/people/:id`,
    { schema: { tags, params: IdParams, body: UpdatePerson, response: { 200: Person } } },
    async (request) => updatePerson(deps, request.params.id, request.body),
  );
  app.delete(
    `${API_PREFIX}/people/:id`,
    { schema: { tags, summary: "Delete a person (409 while linked to todos)", params: IdParams } },
    async (request, reply) => {
      deletePerson(deps, request.params.id);
      return reply.status(204).send();
    },
  );
}
