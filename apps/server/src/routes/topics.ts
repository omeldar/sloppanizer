import { API_PREFIX, IdParams, Team, Topic, TopicQuery, UpdateTopic } from "@organizer/shared";
import { z } from "zod";
import { deleteTopic, listTeams, listTopics, renameTopic } from "../services/topics.ts";
import type { App, Deps } from "./types.ts";

export function topicRoutes(app: App, deps: Deps): void {
  const tags = ["people"];
  app.get(
    `${API_PREFIX}/topics`,
    {
      schema: {
        tags,
        summary: "Topics people help with, by name; q matches any part",
        querystring: TopicQuery,
        response: { 200: z.array(Topic) },
      },
    },
    async (request) => listTopics(deps.db, request.query),
  );
  app.patch(
    `${API_PREFIX}/topics/:id`,
    {
      schema: {
        tags,
        summary: "Rename a topic (409 with the existing one when the name is taken)",
        params: IdParams,
        body: UpdateTopic,
        response: { 200: Topic },
      },
    },
    async (request) => renameTopic(deps, request.params.id, request.body.name),
  );
  app.delete(
    `${API_PREFIX}/topics/:id`,
    { schema: { tags, summary: "Delete a topic (removed from everyone)", params: IdParams } },
    async (request, reply) => {
      deleteTopic(deps, request.params.id);
      return reply.status(204).send();
    },
  );
  app.get(
    `${API_PREFIX}/teams`,
    {
      schema: {
        tags,
        summary: "Distinct teams of people, by name",
        response: { 200: z.array(Team) },
      },
    },
    async () => listTeams(deps.db),
  );
}
