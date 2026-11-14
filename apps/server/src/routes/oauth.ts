import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../config.ts";
import { enforce } from "../http/rate-limit.ts";
import type { AuthServices } from "../services/auth/index.ts";
import {
  type AuthorizeParams,
  checkAuthorizeRequest,
  createOAuth,
  OAUTH_SCOPES,
  OAuthError,
  registerClient,
  withParams,
} from "../services/oauth.ts";
import { authOf, type App, type Deps } from "./types.ts";

export const MCP_PATH = "/api/v1/mcp";
export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
export const AUTHORIZATION_SERVER_PATH = "/.well-known/oauth-authorization-server";

/** The paths any site and any MCP client may call (no cookies here, so CORS * is safe). */
export const isPublicOAuthPath = (path: string): boolean =>
  path === "/oauth/token" ||
  path === "/oauth/register" ||
  path === "/oauth/revoke" ||
  path === AUTHORIZATION_SERVER_PATH ||
  path === PROTECTED_RESOURCE_PATH ||
  path.startsWith(`${PROTECTED_RESOURCE_PATH}/`);

/** This server's own origin: the public URL, else what the request came to. */
export const issuerOf = (config: Config, request: FastifyRequest): string =>
  config.publicUrl ?? `${request.protocol}://${request.host}`;

/** Where the consent page lives: this server when it serves the web app, else the web app's origin. */
const webOriginOf = (config: Config, request: FastifyRequest): string =>
  config.webDir !== null ? issuerOf(config, request) : (config.webOrigins[0] ?? issuerOf(config, request));

const resourceMetadataUrl = (config: Config, request: FastifyRequest) =>
  `${issuerOf(config, request)}${PROTECTED_RESOURCE_PATH}${MCP_PATH}`;

const AuthorizeQuery = z.object({
  response_type: z.string().max(40).optional(),
  client_id: z.string().max(200).optional(),
  redirect_uri: z.string().max(2000).optional(),
  code_challenge: z.string().max(200).optional(),
  code_challenge_method: z.string().max(20).optional(),
  state: z.string().max(2000).optional(),
  scope: z.string().max(200).optional(),
  resource: z.string().max(2000).optional(),
});

const ApproveBody = AuthorizeQuery.extend({ grant: z.enum(OAUTH_SCOPES) });

function sendOAuthError(reply: FastifyReply, error: OAuthError) {
  return reply.status(error.status).header("cache-control", "no-store").send(error.body());
}

/** Form (RFC 6749) or JSON body as plain strings. */
function fields(body: unknown): Record<string, string | undefined> {
  if (body === null || typeof body !== "object") return {};
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(body)) if (typeof value === "string") out[key] = value;
  return out;
}

/**
 * OAuth for MCP clients: discovery (RFC 9728, RFC 8414), dynamic registration (RFC 7591), the authorize
 * redirect to the web app's consent page, the token and revoke endpoints, and the two API calls the
 * consent page makes (describe the request, approve it).
 */
export async function oauthRoutes(app: App, deps: Deps, auth: AuthServices): Promise<void> {
  const { config, limiters } = auth;
  const oauth = createOAuth(deps.db, deps.clock);

  // Every 401 of the MCP endpoint says where to find the authorization server (MCP authorization spec).
  app.addHook("onSend", async (request, reply, payload) => {
    if (reply.statusCode === 401 && (request.url === MCP_PATH || request.url.startsWith(`${MCP_PATH}?`))) {
      reply.header("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl(config, request)}"`);
    }
    return payload;
  });

  const protectedResource = (request: FastifyRequest) => ({
    resource: `${issuerOf(config, request)}${MCP_PATH}`,
    authorization_servers: [issuerOf(config, request)],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Sloppanizer",
  });
  // Plain handlers: the lint rule for async Express handlers misreads these routes.
  app.get("/.well-known/oauth-protected-resource", { schema: { hide: true } }, (request, reply) =>
    reply.send(protectedResource(request)),
  );
  app.get("/.well-known/oauth-protected-resource/api/v1/mcp", { schema: { hide: true } }, (request, reply) =>
    reply.send(protectedResource(request)),
  );

  app.get("/.well-known/oauth-authorization-server", { schema: { hide: true } }, (request, reply) => {
    const issuer = issuerOf(config, request);
    return reply.send({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [...OAUTH_SCOPES],
    });
  });

  await app.register(async (scope) => {
    // RFC 6749 bodies are form encoded; only these routes accept that.
    scope.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string", bodyLimit: 16_384 },
      (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );

    scope.post("/oauth/register", { schema: { hide: true } }, async (request, reply) => {
      const verdict = limiters.oauthRegisterByIp.take(request.ip);
      if (!verdict.ok) {
        return reply
          .status(429)
          .header("retry-after", String(verdict.retryAfterSeconds))
          .send({ error: "slow_down", error_description: "Too many registrations. Try again later." });
      }
      try {
        return reply
          .status(201)
          .header("cache-control", "no-store")
          .send(registerClient(deps.db, deps.clock, request.body));
      } catch (error) {
        if (error instanceof OAuthError) return sendOAuthError(reply, error);
        throw error;
      }
    });

    scope.post("/oauth/token", { schema: { hide: true } }, async (request, reply) => {
      const verdict = limiters.oauthTokenByIp.take(request.ip);
      if (!verdict.ok) {
        return reply
          .status(429)
          .header("retry-after", String(verdict.retryAfterSeconds))
          .send({ error: "slow_down", error_description: "Too many token requests. Try again later." });
      }
      const body = fields(request.body);
      try {
        const answer =
          body.grant_type === "authorization_code"
            ? oauth.exchangeCode(body)
            : body.grant_type === "refresh_token"
              ? oauth.refresh(body)
              : (() => {
                  throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
                })();
        return reply.header("cache-control", "no-store").header("pragma", "no-cache").send(answer);
      } catch (error) {
        if (error instanceof OAuthError) return sendOAuthError(reply, error);
        throw error;
      }
    });

    scope.post("/oauth/revoke", { schema: { hide: true } }, async (request, reply) => {
      enforce(limiters.oauthTokenByIp.take(request.ip));
      oauth.revoke(fields(request.body).token);
      return reply.status(200).header("cache-control", "no-store").send({});
    });
  });

  // The browser comes here from the MCP client; the consent page is part of the web app.
  app.get(
    "/oauth/authorize",
    { schema: { hide: true, querystring: AuthorizeQuery } },
    async (request, reply) => {
      const params = request.query as AuthorizeParams;
      const checked = checkAuthorizeRequest(deps.db, params);
      if (!checked.ok && !checked.redirect) {
        return reply
          .status(400)
          .type("text/plain; charset=utf-8")
          .send(`Sloppanizer cannot connect this app: ${checked.error.message}`);
      }
      if (!checked.ok) {
        return reply.redirect(
          withParams(checked.redirectUri ?? "", { ...checked.error.body(), state: params.state }),
          302,
        );
      }
      const query = new URLSearchParams(request.url.split("?")[1] ?? "");
      return reply.redirect(`${webOriginOf(config, request)}/oauth/authorize?${query.toString()}`, 302);
    },
  );

  // What the consent page shows; the deny address only once the redirect URI is known to be the app's.
  app.get(
    "/api/v1/auth/oauth/request",
    { schema: { hide: true, querystring: AuthorizeQuery }, config: { access: "public" } },
    async (request, reply) => {
      const params = request.query as AuthorizeParams;
      const checked = checkAuthorizeRequest(deps.db, params);
      if (!checked.ok) {
        return reply.status(400).send({
          error: { code: "validation_failed", message: checked.error.message },
          ...(checked.redirect && checked.redirectUri
            ? { denyUrl: withParams(checked.redirectUri, { ...checked.error.body(), state: params.state }) }
            : {}),
        });
      }
      const { client, redirectUri, scope } = checked.request;
      return {
        clientName: client.name,
        redirectHost: new URL(redirectUri).host || new URL(redirectUri).protocol,
        scope,
        denyUrl: withParams(redirectUri, {
          error: "access_denied",
          error_description: "The user did not allow access.",
          state: params.state,
        }),
      };
    },
  );

  // A freshly signed-in browser session approves; tokens (also OAuth ones) can never approve.
  app.post(
    "/api/v1/auth/oauth/approve",
    { schema: { hide: true, body: ApproveBody }, config: { access: "session", reauth: true } },
    async (request, reply) => {
      const { accountId } = authOf(request);
      const body = request.body as z.infer<typeof ApproveBody>;
      const checked = checkAuthorizeRequest(deps.db, body);
      if (!checked.ok) {
        return reply
          .status(400)
          .send({ error: { code: "validation_failed", message: checked.error.message } });
      }
      const code = oauth.approve(accountId, checked.request, body.code_challenge ?? "", body.grant);
      return {
        redirectTo: withParams(checked.request.redirectUri, {
          code,
          state: body.state,
          // RFC 9207. Only with a fixed public URL: this call comes through the web app, so the request's
          // own host may differ from the issuer the client discovered.
          iss: config.publicUrl ?? undefined,
        }),
      };
    },
  );
}
