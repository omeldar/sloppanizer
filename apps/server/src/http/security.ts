import { API_PREFIX, errorBody, SPACE_HEADER } from "@organizer/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/index.ts";
import { getAccount, toAuthAccount } from "../services/accounts.ts";
import { isPublicOAuthPath } from "../routes/oauth.ts";
import { looksLikeAccessToken, readAccessToken } from "../services/auth/access-token.ts";
import type { AuthServices } from "../services/auth/index.ts";
import { localLoginEnded, localLoginEndedMessage } from "../services/auth/omeldar.ts";
import { useSession } from "../services/auth/sessions.ts";
import { memberName, openSpace } from "../services/spaces.ts";
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
    /** Sloppanizer's own sign-in (login, sign-up, credentials): 410 with SLOPPANIZER_AUTH=oidc. */
    localSignIn?: boolean;
    /**
     * Starts a session or an account with Sloppanizer's own credentials (login, sign-up, setup, reset):
     * 410 also once SLOPPANIZER_LOCAL_LOGIN_UNTIL has passed. Credential changes and "confirm it is you"
     * keep working for sessions that are still open, so they can still move to omeldar.
     */
    localLogin?: boolean;
    /**
     * Makes a new account with Sloppanizer's own credentials (sign-up): 410 as soon as omeldar is on
     * (SLOPPANIZER_AUTH=both or oidc). New people sign up at auth.omeldar.com; the first sign-in there
     * makes their Sloppanizer account. Otherwise a sign-up here makes an account auth knows nothing about,
     * which can then never move its sign-in (S5#18).
     */
    localSignup?: boolean;
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

/**
 * Routes that work inside a shared project (X-Sloppanizer-Space): the todo, note and people features.
 * Account, tokens, settings changes, export, restore, AI, meetings, calendar and admin stay personal.
 */
const SPACE_ROUTE =
  /^\/api\/v1\/(todos|projects|labels|people|person-tags|topics|teams|comments|attachments|notes|search|next|stats|blocks|me|users)(\/|$)/;

export function allowedInSpace(route: string | undefined, method: string): boolean {
  if (route === undefined) return false;
  if (route === `${API_PREFIX}/settings`) return SAFE_METHODS.has(method);
  return SPACE_ROUTE.test(route);
}

/**
 * Scopes a request to a shared project: a member (browser session, or an API token of the member's own
 * account, with the token's scope), on a route that works there. The account becomes the space's; the
 * actor is the member's name, so the history says who did it.
 */
function enterSpace(
  db: Db,
  request: FastifyRequest,
  auth: Auth,
  header: string | string[],
): { auth: Auth } | { status: 403 | 404; code: "forbidden" | "not_found"; message: string } {
  const raw = Array.isArray(header) ? header[0] : header;
  const id = raw !== undefined && /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : null;
  if (!allowedInSpace(request.routeOptions.url, request.method)) {
    return { status: 403, code: "forbidden", message: "This is not available inside a shared project." };
  }
  const opened = id === null ? null : openSpace(db, auth.account, id);
  const member = getAccount(db, auth.account.id);
  if (!opened || !member) {
    return {
      status: 404,
      code: "not_found",
      message: "That shared project does not exist or you are not a member. Ask its owner to add you.",
    };
  }
  return {
    auth: {
      ...auth,
      accountId: opened.space.id,
      // A token (an MCP client, a script) acts for its member: "Anna Berg via assistant".
      actor: auth.via === "token" ? `${memberName(member)} via ${auth.actor}` : memberName(member),
      space: { id: opened.space.id, role: opened.role, memberId: member.id },
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
    if (isPublicOAuthPath(request.url.split("?")[0] ?? "")) {
      // Discovery, registration and tokens: any MCP client, also from a browser. No cookies, no session.
      reply.header("Access-Control-Allow-Origin", "*");
      if (request.method === "OPTIONS") {
        return reply
          .header("Access-Control-Allow-Methods", "GET, POST")
          .header("Access-Control-Allow-Headers", "authorization, content-type, mcp-protocol-version")
          .header("Access-Control-Max-Age", "600")
          .status(204)
          .send();
      }
      return;
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
    if (request.routeOptions.config.localSignIn && config.omeldar.mode === "oidc") {
      return reply
        .status(410)
        .send(
          errorBody(
            "gone",
            'Sign-in and account security moved to auth.omeldar.com. Use "Sign in with omeldar".',
          ),
        );
    }
    if (request.routeOptions.config.localSignup && config.omeldar.mode !== "local") {
      return reply
        .status(410)
        .send(
          errorBody(
            "gone",
            'New accounts are made at auth.omeldar.com. Use "Create an account with omeldar".',
          ),
        );
    }
    if (
      request.routeOptions.config.localLogin &&
      localLoginEnded(config.omeldar, options.clock().getTime())
    ) {
      return reply.status(410).send(errorBody("gone", localLoginEndedMessage(config.omeldar)));
    }
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

    const spaceHeader = request.headers[SPACE_HEADER];
    if (spaceHeader !== undefined) {
      const entered = enterSpace(options.db, request, auth, spaceHeader);
      if ("status" in entered)
        return reply.status(entered.status).send(errorBody(entered.code, entered.message));
      request.auth = entered.auth;
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
