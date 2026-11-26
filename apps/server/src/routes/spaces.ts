import {
  AddSpaceMember,
  API_PREFIX,
  CreateFeedback,
  CreateSpace,
  FeedbackResult,
  IdParams,
  MovedTodo,
  MoveTodo,
  Space,
  SpaceMemberParams,
  UpdateSpace,
  UserBrief,
} from "@organizer/shared";
import { z } from "zod";
import type { Config } from "../config.ts";
import { ApiError } from "../http/errors.ts";
import { type AccountRow, getAccount } from "../services/accounts.ts";
import { moveTodo } from "../services/move-todo.ts";
import {
  addSpaceMember,
  createSpace,
  deleteSpace,
  getSpace,
  listSpaces,
  removeSpaceMember,
  searchUsers,
  submitFeedback,
  updateSpace,
} from "../services/spaces.ts";
import { type App, authOf, type Deps } from "./types.ts";

const UsersQuery = z.strictObject({
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

/** Shared projects (managing them; working in one goes through the normal routes) and feedback. */
export function spaceRoutes(app: App, deps: Deps, config: Config): void {
  const tags = ["shared projects"];
  const session = { access: "session" as const };
  /** Listing works with API tokens too (read), so MCP clients find the shared projects to read in. */
  const readable = { access: "auto" as const };
  /** The caller's own account row (never a space: these routes are refused inside one). */
  const me = (request: Parameters<typeof authOf>[0]): AccountRow => {
    const auth = authOf(request);
    const row = getAccount(deps.db, auth.account.id);
    if (!row) throw new ApiError("unauthorized", "Sign in first.");
    return row;
  };

  app.get(
    `${API_PREFIX}/spaces`,
    {
      config: readable,
      schema: { tags, summary: "Shared projects you can open", response: { 200: z.array(Space) } },
    },
    async (request) => listSpaces(deps.db, deps.clock, me(request)),
  );
  app.post(
    `${API_PREFIX}/spaces`,
    {
      config: session,
      schema: { tags, summary: "Create a shared project", body: CreateSpace, response: { 201: Space } },
    },
    async (request, reply) =>
      reply.status(201).send(createSpace(deps.db, deps.clock, me(request), request.body)),
  );
  app.get(
    `${API_PREFIX}/spaces/:id`,
    { config: readable, schema: { tags, params: IdParams, response: { 200: Space } } },
    async (request) => getSpace(deps.db, deps.clock, me(request), request.params.id),
  );
  app.patch(
    `${API_PREFIX}/spaces/:id`,
    {
      config: session,
      schema: {
        tags,
        summary: "Rename or recolor (owners)",
        params: IdParams,
        body: UpdateSpace,
        response: { 200: Space },
      },
    },
    async (request) => updateSpace(deps.db, deps.clock, me(request), request.params.id, request.body),
  );
  app.delete(
    `${API_PREFIX}/spaces/:id`,
    { config: session, schema: { tags, summary: "Delete with all its data (owners)", params: IdParams } },
    async (request, reply) => {
      deleteSpace(deps.db, config, me(request), request.params.id);
      return reply.status(204).send();
    },
  );
  app.post(
    `${API_PREFIX}/spaces/:id/members`,
    {
      config: session,
      schema: {
        tags,
        summary: "Add a member by username (owners)",
        params: IdParams,
        body: AddSpaceMember,
        response: { 200: Space },
      },
    },
    async (request) => addSpaceMember(deps.db, deps.clock, me(request), request.params.id, request.body),
  );
  app.delete(
    `${API_PREFIX}/spaces/:id/members/:accountId`,
    {
      config: session,
      schema: {
        tags,
        summary: "Remove a member (owners), or leave (your own id)",
        params: SpaceMemberParams,
      },
    },
    async (request, reply) => {
      removeSpaceMember(
        deps.db,
        config,
        deps.clock,
        me(request),
        request.params.id,
        request.params.accountId,
      );
      return reply.status(204).send();
    },
  );

  // Sent from where the todo is (your own tab, or the shared project's with its header), like every todo route.
  app.post(
    `${API_PREFIX}/todos/:id/move`,
    {
      schema: {
        tags: ["todos"],
        summary:
          "Move a todo to a shared project or back to your own todos (copied there, this one marked done)",
        params: IdParams,
        body: MoveTodo,
        response: { 200: MovedTodo },
      },
    },
    async (request) =>
      moveTodo(
        deps.db,
        deps.clock,
        { filesDir: deps.filesDir, filesLimitBytes: deps.filesLimitBytes },
        authOf(request),
        request.params.id,
        request.body,
      ),
  );

  app.get(
    `${API_PREFIX}/users`,
    {
      schema: {
        tags: ["people"],
        summary: "Sloppanizer users to add as requester or contact ({ username } in a person reference)",
        querystring: UsersQuery,
        response: { 200: z.array(UserBrief) },
      },
    },
    async (request) =>
      searchUsers(deps.db, authOf(request).account.id, request.query.q ?? "", request.query.limit ?? 8),
  );

  app.post(
    `${API_PREFIX}/feedback`,
    {
      config: session,
      schema: {
        tags,
        summary: "Report a bug or request a feature (goes to the Sloppanizer project)",
        body: CreateFeedback,
        response: { 201: FeedbackResult },
      },
    },
    async (request, reply) =>
      reply.status(201).send(submitFeedback(deps.db, deps.clock, me(request), request.body, deps.version)),
  );
}
