import { API_PREFIX, ApiToken, CreatedToken, CreateToken, IdParams } from "@organizer/shared";
import { z } from "zod";
import { notFound } from "../http/errors.ts";
import { createToken, listTokens, revokeToken } from "../services/tokens.ts";
import type { App, Deps } from "./types.ts";

/** Token management: browser session only, tokens get 403. */
export function tokenRoutes(app: App, deps: Deps): void {
  const config = { access: "session" as const };
  const tags = ["tokens"];
  app.get(
    `${API_PREFIX}/tokens`,
    {
      config,
      schema: { tags, summary: "API tokens (never the raw values)", response: { 200: z.array(ApiToken) } },
    },
    async () => listTokens(deps.db),
  );
  app.post(
    `${API_PREFIX}/tokens`,
    {
      config,
      schema: {
        tags,
        summary: "Create a token; the raw value is returned only here",
        body: CreateToken,
        response: { 201: CreatedToken },
      },
    },
    async (request, reply) => reply.status(201).send(createToken(deps.db, deps.clock, request.body)),
  );
  app.delete(
    `${API_PREFIX}/tokens/:id`,
    { config, schema: { tags, summary: "Revoke a token", params: IdParams } },
    async (request, reply) => {
      if (!revokeToken(deps.db, deps.clock, request.params.id)) throw notFound("Token", request.params.id);
      return reply.status(204).send();
    },
  );
}
