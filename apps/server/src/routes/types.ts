import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ApiError } from "../http/errors.ts";
import type { Auth, Ctx } from "../services/context.ts";
import type { RestoreLimits } from "../services/restore.ts";

export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export interface Deps extends Ctx {
  version: string;
  /** Absolute path of the data dir. */
  dataDir: string;
  /** Absolute path of <data dir>/attachments (uploaded files, one per id). */
  attachmentsDir: string;
  /** Size limits of restore uploads. */
  limits: RestoreLimits;
  /** One restore at a time. */
  restoreLock: { busy: boolean };
}

/** The acting user of a request (set by the security hook). */
export const actorOf = (request: { auth: { actor: string } | null }): string => request.auth?.actor ?? "you";

/** Who is calling, for routes whose rules depend on it. Never assumes the session when auth is missing. */
export function authOf(request: { auth: Auth | null }): Auth {
  if (!request.auth) throw new ApiError("unauthorized", "Sign in first.");
  return request.auth;
}
