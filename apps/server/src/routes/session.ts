import type { FastifyRequest } from "fastify";
import { ApiError } from "../http/errors.ts";
import { type Client, SESSION_ENDED } from "../services/auth/login.ts";

/** Who is calling, for session rows and the per-IP limits. request.ip honours the trusted proxies only. */
export const clientOf = (request: FastifyRequest): Client => ({
  ip: request.ip,
  userAgent: String(request.headers["user-agent"] ?? "").slice(0, 200),
});

/** The browser session of a request on a session-only route. */
export function sessionOf(request: FastifyRequest): { accountId: number; sessionId: string } {
  const auth = request.auth;
  if (auth?.via !== "session") throw new ApiError("unauthorized", SESSION_ENDED);
  return { accountId: auth.accountId, sessionId: auth.sessionId };
}
