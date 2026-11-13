import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { isValidTimeZone } from "@organizer/shared";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/index.ts";
import { ApiError } from "../http/errors.ts";
import { accountFilesDir } from "../services/attachments.ts";
import type { Auth, Ctx } from "../services/context.ts";
import type { RestoreCtx, RestoreEnv } from "../services/restore.ts";

export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

/**
 * What the routes share: the database, the clock and the server's folders and limits. Nothing in here
 * names an account; every user data route builds its context from the caller (ctxOf).
 */
export interface Deps extends RestoreEnv {
  db: Db;
  clock: Clock;
  /** Used only when an account's own time zone is broken. */
  fallbackTimeZone: string;
}

/** The acting user of a request (set by the security hook). */
export const actorOf = (request: { auth: { actor: string } | null }): string => request.auth?.actor ?? "you";

/** Who is calling, for routes whose rules depend on it. Never assumes the session when auth is missing. */
export function authOf(request: { auth: Auth | null }): Auth {
  if (!request.auth) throw new ApiError("unauthorized", "Sign in first.");
  return request.auth;
}

/**
 * The service context of a request: scoped to the caller's account (from the security hook, never
 * from input) in the account's time zone.
 */
export function ctxOf(request: { auth: Auth | null }, deps: Deps): Ctx {
  const auth = authOf(request);
  const zone = auth.account.timeZone;
  return {
    db: deps.db,
    clock: deps.clock,
    timeZone: isValidTimeZone(zone) ? zone : deps.fallbackTimeZone,
    accountId: auth.accountId,
  };
}

/** The context of a restore or export: the account's context plus the server's folders and limits. */
export function restoreCtxOf(request: { auth: Auth | null }, deps: Deps): RestoreCtx {
  const { account } = authOf(request);
  return { ...deps, ...ctxOf(request, deps), account };
}

/** The caller's files folder (<files dir>/<account id>, made on first use). */
export const filesDirOf = (request: { auth: Auth | null }, deps: Deps): string =>
  accountFilesDir(deps.filesDir, authOf(request).accountId);
