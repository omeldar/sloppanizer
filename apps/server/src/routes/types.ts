import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ApiError } from "../http/errors.ts";
import type { Auth } from "../http/security.ts";
import type { Ctx } from "../services/context.ts";

export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export interface Deps extends Ctx {
  version: string;
  /** Absolute path of <data dir>/attachments (uploaded files, one per id). */
  attachmentsDir: string;
}

/** The acting user of a request (set by the security hook). */
export const actorOf = (request: { auth: { actor: string } | null }): string => request.auth?.actor ?? "you";

/** Who is calling, for routes whose rules depend on it. Never assumes the session when auth is missing. */
export function authOf(request: { auth: Auth | null }): Auth {
  if (!request.auth) throw new ApiError("unauthorized", "Sign in first.");
  return request.auth;
}
