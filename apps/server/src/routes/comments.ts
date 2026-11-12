import { Activity, API_PREFIX, Comment, CreateComment, IdParams, UpdateComment } from "@organizer/shared";
import { z } from "zod";
import { getActivity } from "../services/activity.ts";
import { createComment, deleteComment, listComments, updateComment } from "../services/comments.ts";
import { authOf, type App, type Deps } from "./types.ts";

export function commentRoutes(app: App, deps: Deps): void {
  const tags = ["comments"];
  app.get(
    `${API_PREFIX}/todos/:id/activity`,
    {
      schema: {
        tags,
        summary: "Comments and history of a todo in one thread, oldest first (newest 2000 items)",
        params: IdParams,
        response: { 200: Activity },
      },
    },
    async (request) => getActivity(deps.db, request.params.id),
  );
  app.get(
    `${API_PREFIX}/todos/:id/comments`,
    { schema: { tags, params: IdParams, response: { 200: z.array(Comment) } } },
    async (request) => listComments(deps.db, request.params.id),
  );
  app.post(
    `${API_PREFIX}/todos/:id/comments`,
    {
      schema: {
        tags,
        summary: "Comment on a todo (moves its last activity)",
        params: IdParams,
        body: CreateComment,
        response: { 201: Comment },
      },
    },
    async (request, reply) =>
      reply.status(201).send(createComment(deps, authOf(request), request.params.id, request.body.bodyMd)),
  );
  app.patch(
    `${API_PREFIX}/comments/:id`,
    {
      schema: {
        tags,
        summary: "Edit a comment (tokens: only their own)",
        params: IdParams,
        body: UpdateComment,
        response: { 200: Comment },
      },
    },
    async (request) => updateComment(deps, authOf(request), request.params.id, request.body.bodyMd),
  );
  app.delete(
    `${API_PREFIX}/comments/:id`,
    { schema: { tags, summary: "Delete a comment for good (tokens: only their own)", params: IdParams } },
    async (request, reply) => {
      deleteComment(deps, authOf(request), request.params.id);
      return reply.status(204).send();
    },
  );
}
