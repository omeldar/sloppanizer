import { API_PREFIX, errorBody } from "@organizer/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/index.ts";
import { getAccount, toAuthAccount } from "../services/accounts.ts";
import { looksLikeAccessToken, readAccessToken } from "../services/auth/access-token.ts";
import type { AuthServices } from "../services/auth/index.ts";
import { useSession } from "../services/auth/sessions.ts";
import type { Auth } from "../services/context.ts";
import { verifyToken } from "../services/tokens.ts";
import { applyCors } from "./cors.ts";
import { unknownRouteBody } from "./web.ts";

/** Fallback CSP for HTML the API serves itself (the API docs page). The web app has its own headers. */
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

/** Log fields that could carry secrets (bodies are never logged). */
export const LOG_REDACT = ["req.headers.authorization", "req.headers.cookie", "headers.authorization"];

export const HSTS = "max-age=63072000; includeSubDomains";

/** Sensitive actions need a full sign-in (login or reauth) at most this long ago. */
export const REAUTH_WINDOW_MS = 10 * 60 * 1000;

/**
 * Who may call a route:
 * - "public": no auth (health, the sign-in flows; those have their own rate limits).
 * - "auto" (default): session, or a token; read tokens only for GET/HEAD.
 * - "write": session or a write token, even for GET (export).
 * - "session": a browser session only; tokens get 403.
 * - "admin": a session of an admin account. Everyone else gets the 404 of a route that does not exist.
 * - "any": session or any token, also read tokens for POST. Only for routes that do nothing themselves
 *   but call other API routes with the caller's own token (the MCP endpoint); those check the scope.
 */
export type Access = "public" | "auto" | "write" | "session" | "admin" | "any";

export type { Auth };

declare module "fastify" {
  interface FastifyContextConfig {
    access?: Access;
    /** Needs a full sign-in within the last 10 minutes (403 reauth_required otherwise). */
    reauth?: boolean;
    /** Counts against the upload limit too (60 per minute per account). */
    upload?: boolean;
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

type DenyStatus = 401 | 403 | 421 | 429;

function deny(reply: FastifyReply, status: DenyStatus, message: string, details?: unknown): FastifyReply {
  const code =
    status === 401
      ? "unauthorized"
      : status === 403
        ? "forbidden"
        : status === 429
          ? "too_many_requests"
          : "unknown_host";
  return reply.status(status).send(errorBody(code, message, details));
}

export interface SecurityOptions {
  db: Db;
  clock: Clock;
  auth: AuthServices;
}

const looksLikeApi = (path: string): boolean => path === "/api" || path.startsWith("/api/");

/**
 * Whether the request is an API call that needs auth. Decided by the route that matched (the router
 * decodes %XX, so "/%61pi/v1/todos" reaches /api/v1/todos) and, failing closed, also by the raw and
 * the decoded path: any of them under /api counts, and a path that cannot be decoded counts too.
 */
function needsApiAuth(request: FastifyRequest): boolean {
  const route = request.routeOptions.url;
  if (route !== undefined && looksLikeApi(route)) return true;
  const path = request.url.split("?")[0] ?? "";
  if (looksLikeApi(path)) return true;
  try {
    return looksLikeApi(decodeURIComponent(path));
  } catch {
    return true;
  }
}

const TOKEN_REJECTED =
  "The API token is not valid, revoked or expired, or its account is disabled. Create a new one in Sloppanizer under Settings, API tokens.";
const SESSION_ENDED = "Your session has ended. Sign in again.";
const SIGN_IN_FIRST = "Sign in first, or send Authorization: Bearer <token>.";

/** Resolves a bearer value to the caller, or null (unknown, expired, revoked, account not active). */
export function authenticate(
  options: SecurityOptions,
  raw: string,
  ip: string | null,
): { auth: Auth } | { error: string } {
  const nowMs = options.clock().getTime();
  if (looksLikeAccessToken(raw)) {
    const payload = readAccessToken(options.auth.accessKey, raw, nowMs);
    const session = payload ? useSession(options.db, nowMs, payload.sid, payload.aid, ip) : null;
    const account = session ? getAccount(options.db, session.accountId) : undefined;
    if (!session || account?.status !== "active") return { error: SESSION_ENDED };
    return {
      auth: {
        accountId: account.id,
        account: toAuthAccount(account),
        actor: "you",
        via: "session",
        scope: "write",
        sessionId: session.id,
        authenticatedAt: session.authenticatedAt,
      },
    };
  }
  const token = verifyToken(options.db, options.clock, raw);
  const account = token ? getAccount(options.db, token.accountId) : undefined;
  if (!token || account?.status !== "active") return { error: TOKEN_REJECTED };
  return {
    auth: {
      accountId: account.id,
      account: toAuthAccount(account),
      actor: token.name,
      via: "token",
      scope: token.scope,
      tokenId: token.id,
    },
  };
}

/** Whether the session's last full sign-in is recent enough for a sensitive action. */
export const freshlyAuthenticated = (auth: Auth, nowMs: number): boolean =>
  auth.via === "session" && nowMs - Date.parse(auth.authenticatedAt) <= REAUTH_WINDOW_MS;

/** Host allowlist, CORS, the Origin check, auth, rate limits and security headers. Register before the routes. */
export function registerSecurity(app: FastifyInstance, options: SecurityOptions): void {
  const { config, limiters } = options.auth;
  const allowedHosts = new Set(config.allowedHosts.map((h) => h.toLowerCase()));
  const allowedOrigins = new Set([...config.webOrigins, ...(config.publicUrl ? [config.publicUrl] : [])]);
  app.decorateRequest("auth", null);

  app.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host;
    if (!host || !allowedHosts.has(hostName(host))) {
      return deny(reply, 421, "This server does not answer to that host name.");
    }
    if (applyCors(request, reply, { webOrigins: config.webOrigins })) return reply;

    const unsafe = !SAFE_METHODS.has(request.method);
    const origin = request.headers.origin;
    // Browsers send Origin on every cross-origin call and on unsafe same-origin ones. No Origin
    // (MCP clients, scripts): the bearer token decides.
    if (unsafe && origin !== undefined && !allowedOrigins.has(origin)) {
      return deny(reply, 403, "Requests from other sites are not allowed. Use the Sloppanizer web app.");
    }
    if (!needsApiAuth(request)) return;

    const access: Access = request.routeOptions.config.access ?? "auto";
    if (access === "public") return;

    const notFound = () => {
      const path = request.url.split("?")[0] ?? "/";
      return reply.status(404).send(unknownRouteBody(request.method, path));
    };

    const authorization = request.headers.authorization;
    const match = authorization === undefined ? null : /^Bearer\s+(\S{1,512})$/i.exec(authorization);
    if (!match?.[1]) {
      if (access === "admin") return notFound();
      return deny(reply, 401, authorization === undefined ? SIGN_IN_FIRST : TOKEN_REJECTED);
    }
    const result = authenticate(options, match[1], request.ip);
    if ("error" in result) {
      if (access === "admin") return notFound();
      return deny(reply, 401, result.error);
    }
    const auth = result.auth;
    if (access === "admin" && (auth.via !== "session" || auth.account.role !== "admin")) return notFound();
    request.auth = auth;

    if (auth.via === "token") {
      if (access === "session") {
        return deny(reply, 403, "API tokens cannot use this endpoint. Use the Sloppanizer web app.");
      }
      const needsWrite = access === "write" || (unsafe && access !== "any");
      if (needsWrite && auth.scope !== "write") {
        return deny(reply, 403, "This token can only read. Use a token with the write scope for changes.");
      }
    }

    for (const limiter of request.routeOptions.config.upload
      ? [limiters.apiByAccount, limiters.uploadsByAccount]
      : [limiters.apiByAccount]) {
      const verdict = limiter.take(String(auth.accountId));
      if (!verdict.ok) {
        reply.header("Retry-After", String(verdict.retryAfterSeconds));
        return deny(reply, 429, `Too many requests. Try again in ${verdict.retryAfterSeconds} seconds.`, {
          retryAfterSeconds: verdict.retryAfterSeconds,
        });
      }
    }

    if (request.routeOptions.config.reauth && !freshlyAuthenticated(auth, options.clock().getTime())) {
      return reply
        .status(403)
        .send(errorBody("reauth_required", "Confirm it is you: enter your password and code again."));
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    if (!reply.hasHeader("cross-origin-resource-policy"))
      reply.header("Cross-Origin-Resource-Policy", "same-origin");
    if (request.protocol === "https") reply.header("Strict-Transport-Security", HSTS);
    const type = reply.getHeader("content-type");
    if (
      typeof type === "string" &&
      type.startsWith("application/json") &&
      !reply.hasHeader("cache-control")
    ) {
      reply.header("Cache-Control", "no-store");
    }
    // Every 429 tells when to try again, also those thrown by services (details.retryAfterSeconds).
    if (reply.statusCode === 429 && !reply.hasHeader("retry-after") && typeof payload === "string") {
      try {
        const seconds = (JSON.parse(payload) as { error?: { details?: { retryAfterSeconds?: unknown } } })
          .error?.details?.retryAfterSeconds;
        if (typeof seconds === "number") reply.header("Retry-After", String(seconds));
      } catch {
        // Not JSON: nothing to read.
      }
    }
    // A route's own policy wins (attachments are sandboxed whatever their type).
    if (
      typeof type === "string" &&
      type.startsWith("text/html") &&
      !reply.hasHeader("content-security-policy")
    ) {
      reply.header("Content-Security-Policy", CSP);
    }
    return payload;
  });
}

export const isApiPath = (url: string): boolean => url === API_PREFIX || url.startsWith(`${API_PREFIX}/`);
