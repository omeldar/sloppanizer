import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * CORS for the web app's origins only. Calls carry a bearer token, never cookies, so there is never an
 * Allow-Credentials header. Every response varies on Origin (a cache must not hand one origin's answer
 * to another).
 */

export const CORS_ALLOW_METHODS = "GET, POST, PATCH, DELETE";
export const CORS_ALLOW_HEADERS = "authorization, content-type, accept, x-sloppanizer-space";
export const CORS_EXPOSE_HEADERS = "content-disposition, retry-after";
const MAX_AGE_SECONDS = "600";

export interface CorsOptions {
  webOrigins: readonly string[];
}

/**
 * Adds the CORS headers for an allowed Origin and answers preflights. Returns true when it answered the
 * request (a preflight), so the caller stops.
 */
export function applyCors(request: FastifyRequest, reply: FastifyReply, options: CorsOptions): boolean {
  reply.header("Vary", "Origin");
  const origin = request.headers.origin;
  const allowed = origin !== undefined && options.webOrigins.includes(origin);
  const preflight =
    request.method === "OPTIONS" && request.headers["access-control-request-method"] !== undefined;
  if (preflight) {
    if (!allowed) {
      reply.status(403).send({ error: { code: "forbidden", message: "This origin may not call the API." } });
      return true;
    }
    reply
      .header("Access-Control-Allow-Origin", origin)
      .header("Access-Control-Allow-Methods", CORS_ALLOW_METHODS)
      .header("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS)
      .header("Access-Control-Max-Age", MAX_AGE_SECONDS)
      .status(204)
      .send();
    return true;
  }
  if (allowed) {
    reply
      .header("Access-Control-Allow-Origin", origin)
      .header("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS);
  }
  return false;
}
