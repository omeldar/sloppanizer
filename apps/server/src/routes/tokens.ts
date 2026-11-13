import { API_PREFIX, ApiToken, CreatedToken, CreateToken, IdParams } from "@organizer/shared";
import { z } from "zod";
import { notFound } from "../http/errors.ts";
import { createToken, listTokens, revokeToken } from "../services/tokens.ts";
import { type App, authOf, type Deps } from "./types.ts";

/** Token management of the caller's account: browser session only, tokens get 403; creating one needs a recent sign-in. */
export function tokenRoutes(app: App, deps: Deps): void {
  const config = { access: "session" as const };
  const tags = ["tokens"];
  app.get(
    `${API_PREFIX}/tokens`,
    {
      config,
      schema: { tags, summary: "API tokens (never the raw values)", response: { 200: z.array(ApiToken) } },
    },
    async (request) => listTokens(deps.db, authOf(request).accountId),
  );
  app.post(
    `${API_PREFIX}/tokens`,
    {
      config: { ...config, reauth: true },
      schema: {
        tags,
        summary: "Create a token; the raw value is returned only here",
        body: CreateToken,
        response: { 201: CreatedToken },
      },
    },
    async (request, reply) =>
      reply.status(201).send(createToken(deps.db, deps.clock, authOf(request).accountId, request.body)),
  );
  app.delete(
    `${API_PREFIX}/tokens/:id`,
    { config, schema: { tags, summary: "Revoke a token", params: IdParams } },
    async (request, reply) => {
      if (!revokeToken(deps.db, deps.clock, authOf(request).accountId, request.params.id))
        throw notFound("Token", request.params.id);
      return reply.status(204).send();
    },
  );
}
