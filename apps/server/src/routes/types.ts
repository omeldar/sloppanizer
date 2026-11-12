import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
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
