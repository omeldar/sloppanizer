import { randomBytes } from "node:crypto";
import { API_PREFIX, errorBody } from "@organizer/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/index.ts";
import type { Auth } from "../services/context.ts";
import { verifyToken } from "../services/tokens.ts";

export const SESSION_COOKIE = "org_session";
/** Browsers cap cookie lifetime at 400 days. */
const SESSION_MAX_AGE_S = 400 * 24 * 3600;

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

/**
 * Who may call a route:
 * - "public": no auth (health).
 * - "auto" (default): session, or a token; read tokens only for GET/HEAD.
 * - "write": session or a write token, even for GET (export).
 * - "session": the browser session only; tokens get 403 (token management).
 */
export type Access = "public" | "auto" | "write" | "session";

export type { Auth };

declare module "fastify" {
  interface FastifyContextConfig {
    access?: Access;
  }
  interface FastifyRequest {
    auth: Auth | null;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Host name without port, lowercase; IPv6 keeps its brackets ("[::1]"). */
export function hostName(hostHeader: string): string {
  const host = hostHeader.trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.indexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

function originHost(origin: string): string | null {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" || url.protocol === "https:" ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

function deny(reply: FastifyReply, status: 401 | 403 | 421, message: string): FastifyReply {
  const code = status === 401 ? "unauthorized" : status === 403 ? "forbidden" : "unknown_host";
  return reply.status(status).send(errorBody(code, message));
}

/** Sets the signed browser session cookie (done whenever the web app HTML is served). */
export function setSessionCookie(request: FastifyRequest, reply: FastifyReply): void {
  reply.setCookie(SESSION_COOKIE, `s1.${randomBytes(16).toString("hex")}`, {
    signed: true,
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    secure: request.protocol === "https",
    maxAge: SESSION_MAX_AGE_S,
  });
}

function hasValidSession(request: FastifyRequest): boolean {
  const cookie = request.cookies[SESSION_COOKIE];
  return cookie !== undefined && request.unsignCookie(cookie).valid;
}

export interface SecurityOptions {
  db: Db;
  clock: Clock;
  allowedHosts: readonly string[];
}

/** Host allowlist, CSRF checks, auth and security headers. Register before the routes. */
export function registerSecurity(app: FastifyInstance, options: SecurityOptions): void {
  const allowed = new Set(options.allowedHosts.map((h) => h.toLowerCase()));
  app.decorateRequest("auth", null);

  app.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host;
    if (!host || !allowed.has(hostName(host))) {
      return deny(
        reply,
        421,
        "This server does not answer to that host name. Use http://organizer.localhost or localhost.",
      );
    }

    const isApi = request.url === "/api" || request.url.startsWith("/api/");
    const unsafe = !SAFE_METHODS.has(request.method);
    if (unsafe || isApi) {
      if (request.headers["sec-fetch-site"] === "cross-site") {
        return deny(reply, 403, "Cross-site requests are not allowed. Use the organizer web app.");
      }
    }
    if (unsafe) {
      const origin = request.headers.origin;
      if (origin !== undefined) {
        const originName = originHost(origin);
        // WHATWG URL keeps the brackets of IPv6 host names, like the allowlist.
        if (originName === null || !allowed.has(originName)) {
          return deny(reply, 403, "Requests from other sites are not allowed. Use the organizer web app.");
        }
      }
    }
    if (!isApi) return;

    const access: Access = request.routeOptions.config.access ?? "auto";
    if (access === "public") return;

    const authorization = request.headers.authorization;
    if (authorization !== undefined) {
      const match = /^Bearer\s+(\S+)$/i.exec(authorization);
      const token = match?.[1] ? verifyToken(options.db, options.clock, match[1]) : null;
      if (!token) {
        return deny(
          reply,
          401,
          "The API token is not valid, revoked or expired. Create a new one in the settings.",
        );
      }
      request.auth = { actor: token.name, via: "token", tokenId: token.id, scope: token.scope };
    } else if (hasValidSession(request)) {
      request.auth = { actor: "you", via: "session", scope: "write" };
    } else {
      return deny(
        reply,
        401,
        "Sign in first: open the organizer web app, or send Authorization: Bearer <token>.",
      );
    }

    if (request.auth.via === "token") {
      if (access === "session") {
        return deny(reply, 403, "API tokens cannot use this endpoint. Use the organizer web app.");
      }
      const needsWrite = access === "write" || unsafe;
      if (needsWrite && request.auth.scope !== "write") {
        return deny(reply, 403, "This token can only read. Use a token with the write scope for changes.");
      }
    }
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    const type = reply.getHeader("content-type");
    if (typeof type === "string" && type.startsWith("text/html")) {
      reply.header("Content-Security-Policy", CSP);
    }
    return payload;
  });
}

export const isApiPath = (url: string): boolean => url === API_PREFIX || url.startsWith(`${API_PREFIX}/`);
