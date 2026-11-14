import { createHash, randomBytes } from "node:crypto";
import { type TokenScope, TOKEN_PREFIX_LENGTH } from "@organizer/shared";
import { and, eq, isNull, lt, notExists, sql } from "drizzle-orm";
import type { Clock } from "../clock.ts";
import { oauthClients, oauthGrants } from "../db/auth-schema.ts";
import type { Db } from "../db/index.ts";
import { apiTokens } from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import { createToken, generateRawToken, hashToken, MAX_ACTIVE_TOKENS, revokeToken } from "./tokens.ts";

/**
 * OAuth 2.1 for MCP clients (authorization code with PKCE, public clients, dynamic registration). An
 * approved grant gets an API token of the account as its access token: it shows on the tokens page,
 * revoking it there ends the grant, and every API rule for tokens applies to it.
 */

export const ACCESS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
/** Registered clients that never got a grant are dropped after this. */
const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REDIRECT_URIS = 10;

export const OAUTH_SCOPES = ["read", "write"] as const;

/** An OAuth error answer (RFC 6749 5.2 / RFC 7591 3.2.2). */
export class OAuthError extends Error {
  readonly status: number;
  readonly error: string;

  constructor(error: string, description: string, status = 400) {
    super(description);
    this.error = error;
    this.status = status;
  }

  body() {
    return { error: this.error, error_description: this.message };
  }
}

const random = (bytes: number) => randomBytes(bytes).toString("base64url");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:"]);

/** https, http on the loopback (native apps, RFC 8252), or a private app scheme like com.example.app:. */
function checkRedirectUri(value: unknown): string {
  if (typeof value !== "string" || value.length > 2000) {
    throw new OAuthError(
      "invalid_redirect_uri",
      "Each redirect URI must be a string of at most 2000 characters.",
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthError("invalid_redirect_uri", `${value} is not an absolute URI.`);
  }
  if (url.hash) throw new OAuthError("invalid_redirect_uri", "A redirect URI must not have a fragment.");
  const ok =
    url.protocol === "https:" ||
    (url.protocol === "http:" && LOOPBACK.has(url.hostname)) ||
    (!BLOCKED_SCHEMES.has(url.protocol) &&
      url.protocol !== "http:" &&
      /^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]*:$/.test(url.protocol));
  if (!ok) {
    throw new OAuthError(
      "invalid_redirect_uri",
      `${value} is not allowed: use https, http on localhost, or a private app scheme.`,
    );
  }
  return value;
}

/** Exact match; loopback http URIs match on any port (RFC 8252 7.3). */
function redirectMatches(registered: readonly string[], given: string): boolean {
  if (registered.includes(given)) return true;
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname)) return false;
  return registered.some((entry) => {
    const reg = new URL(entry);
    return (
      reg.protocol === "http:" &&
      reg.hostname === url.hostname &&
      reg.pathname === url.pathname &&
      reg.search === url.search
    );
  });
}

const cleanName = (value: unknown): string => {
  const name =
    typeof value === "string"
      ? value
          .replace(/[\p{Cc}\p{Cf}]/gu, "")
          .trim()
          .slice(0, 60)
      : "";
  return name || "MCP client";
};

export interface RegisteredClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  client_id_issued_at: number;
  token_endpoint_auth_method: "none";
  grant_types: string[];
  response_types: string[];
}

/** Dynamic client registration. Also drops clients that registered a day ago and were never used. */
export function registerClient(db: Db, clock: Clock, input: unknown): RegisteredClient {
  const body = (input ?? {}) as Record<string, unknown>;
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    throw new OAuthError("invalid_redirect_uri", `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs.`);
  }
  const redirectUris = [...new Set(uris.map(checkRedirectUri))];
  const grantTypes = body.grant_types;
  if (
    grantTypes !== undefined &&
    (!Array.isArray(grantTypes) ||
      grantTypes.some((g) => g !== "authorization_code" && g !== "refresh_token"))
  ) {
    throw new OAuthError(
      "invalid_client_metadata",
      "Only the authorization_code and refresh_token grants exist here.",
    );
  }
  const now = clock();
  const cutoff = new Date(now.getTime() - UNUSED_CLIENT_TTL_MS).toISOString();
  db.delete(oauthClients)
    .where(
      and(
        isNull(oauthClients.lastUsedAt),
        lt(oauthClients.createdAt, cutoff),
        notExists(
          db
            .select({ one: sql`1` })
            .from(oauthGrants)
            .where(eq(oauthGrants.clientId, oauthClients.id)),
        ),
      ),
    )
    .run();
  const id = random(24);
  const name = cleanName(body.client_name);
  db.insert(oauthClients)
    .values({ id, name, redirectUris: JSON.stringify(redirectUris), createdAt: now.toISOString() })
    .run();
  return {
    client_id: id,
    client_name: name,
    redirect_uris: redirectUris,
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
}

type ClientRow = typeof oauthClients.$inferSelect;

export interface AuthorizeParams {
  response_type?: string | undefined;
  client_id?: string | undefined;
  redirect_uri?: string | undefined;
  code_challenge?: string | undefined;
  code_challenge_method?: string | undefined;
  state?: string | undefined;
  scope?: string | undefined;
  resource?: string | undefined;
}

export interface CheckedRequest {
  client: ClientRow;
  redirectUri: string;
  /** The scope asked for: write unless only read was asked. */
  scope: TokenScope;
}

/**
 * Checks an authorization request. Problems with the client or its redirect URI are never sent to that
 * URI (`redirect: false`); the others go back to the client as ?error=.
 */
export function checkAuthorizeRequest(
  db: Db,
  params: AuthorizeParams,
):
  | { ok: true; request: CheckedRequest }
  | { ok: false; redirect: boolean; error: OAuthError; redirectUri?: string } {
  const client = params.client_id
    ? db.select().from(oauthClients).where(eq(oauthClients.id, params.client_id)).get()
    : undefined;
  if (!client) {
    return {
      ok: false,
      redirect: false,
      error: new OAuthError("invalid_client", "This app is not registered here. Connect it again."),
    };
  }
  const registered = JSON.parse(client.redirectUris) as string[];
  const redirectUri = params.redirect_uri ?? (registered.length === 1 ? registered[0] : undefined);
  if (!redirectUri || !redirectMatches(registered, redirectUri)) {
    return {
      ok: false,
      redirect: false,
      error: new OAuthError("invalid_request", "The redirect URI does not belong to this app."),
    };
  }
  const fail = (error: string, description: string) => ({
    ok: false as const,
    redirect: true,
    redirectUri,
    error: new OAuthError(error, description),
  });
  if (params.response_type !== "code")
    return fail("unsupported_response_type", "Only response_type=code is supported.");
  if (!params.code_challenge || !/^[A-Za-z0-9._~-]{43,128}$/.test(params.code_challenge)) {
    return fail("invalid_request", "PKCE is required: send a code_challenge.");
  }
  if (params.code_challenge_method !== "S256")
    return fail("invalid_request", "code_challenge_method must be S256.");
  const asked = (params.scope ?? "").split(/\s+/).filter(Boolean);
  if (asked.some((s) => !(OAUTH_SCOPES as readonly string[]).includes(s))) {
    return fail("invalid_scope", `Known scopes: ${OAUTH_SCOPES.join(", ")}.`);
  }
  const scope: TokenScope = asked.length > 0 && !asked.includes("write") ? "read" : "write";
  return { ok: true, request: { client, redirectUri, scope } };
}

/** Appends OAuth answer parameters to a redirect URI (keeping its own query). */
export function withParams(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params))
    if (value !== undefined) url.searchParams.set(key, value);
  return url.toString();
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  accountId: number;
  scope: TokenScope;
  expiresAtMs: number;
}

export interface TokenAnswer {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: TokenScope;
}

/** The OAuth state of one server: pending codes live in memory (10 minutes, one use). */
export function createOAuth(db: Db, clock: Clock) {
  const codes = new Map<string, PendingCode>();

  const prune = (nowMs: number) => {
    for (const [key, code] of codes) if (code.expiresAtMs <= nowMs) codes.delete(key);
  };

  /** The account approved the request: a one-time code for the client. */
  function approve(accountId: number, request: CheckedRequest, challenge: string, scope: TokenScope): string {
    const nowMs = clock().getTime();
    prune(nowMs);
    const code = random(32);
    codes.set(sha256(code), {
      clientId: request.client.id,
      redirectUri: request.redirectUri,
      challenge,
      accountId,
      // Never more than the client asked for.
      scope: request.scope === "read" ? "read" : scope,
      expiresAtMs: nowMs + CODE_TTL_MS,
    });
    return code;
  }

  /** A free token name for the client: "Claude", else "Claude 2", "Claude 3", ... */
  function tokenName(accountId: number, base: string): string {
    const nowMs = clock().getTime();
    const taken = new Set(
      db
        .select()
        .from(apiTokens)
        .where(and(eq(apiTokens.accountId, accountId), isNull(apiTokens.revokedAt)))
        .all()
        .filter((row) => row.expiresAt === null || Date.parse(row.expiresAt) > nowMs)
        .map((row) => row.name.toLowerCase()),
    );
    const name = base.toLowerCase() === "you" ? `${base} app` : base;
    for (let n = 1; n <= MAX_ACTIVE_TOKENS + 1; n++) {
      const candidate = n === 1 ? name : `${name} ${n}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return name;
  }

  /** Ends the grant and revokes its token. */
  function endGrant(grant: typeof oauthGrants.$inferSelect): void {
    const now = clock().toISOString();
    db.update(oauthGrants).set({ revokedAt: now }).where(eq(oauthGrants.id, grant.id)).run();
    revokeToken(db, clock, grant.accountId, grant.tokenId);
  }

  function exchangeCode(params: {
    code?: string;
    code_verifier?: string;
    client_id?: string;
    redirect_uri?: string;
  }): TokenAnswer {
    const nowMs = clock().getTime();
    prune(nowMs);
    const key = params.code ? sha256(params.code) : "";
    const pending = codes.get(key);
    if (!pending)
      throw new OAuthError("invalid_grant", "The code is unknown, used or expired. Connect again.");
    codes.delete(key);
    if (params.client_id !== undefined && params.client_id !== pending.clientId) {
      throw new OAuthError("invalid_grant", "The code was issued to another client.");
    }
    if (params.redirect_uri !== undefined && params.redirect_uri !== pending.redirectUri) {
      throw new OAuthError(
        "invalid_grant",
        "redirect_uri differs from the one of the authorization request.",
      );
    }
    if (!params.code_verifier || s256(params.code_verifier) !== pending.challenge) {
      throw new OAuthError("invalid_grant", "The PKCE code_verifier does not match.");
    }
    const client = db.select().from(oauthClients).where(eq(oauthClients.id, pending.clientId)).get();
    if (!client) throw new OAuthError("invalid_client", "This app is not registered here any more.", 401);

    return db.transaction(() => {
      // One live grant per account and app: connecting again replaces the old one.
      for (const old of db
        .select()
        .from(oauthGrants)
        .where(
          and(
            eq(oauthGrants.accountId, pending.accountId),
            eq(oauthGrants.clientId, client.id),
            isNull(oauthGrants.revokedAt),
          ),
        )
        .all()) {
        endGrant(old);
      }
      const now = new Date(nowMs);
      let created: ReturnType<typeof createToken>;
      try {
        created = createToken(db, clock, pending.accountId, {
          name: tokenName(pending.accountId, client.name),
          scope: pending.scope,
          expiresAt: new Date(nowMs + ACCESS_TTL_MS).toISOString(),
        });
      } catch (error) {
        if (error instanceof ApiError) throw new OAuthError("invalid_grant", error.message);
        throw error;
      }
      const refreshToken = random(32);
      db.insert(oauthGrants)
        .values({
          accountId: pending.accountId,
          clientId: client.id,
          tokenId: created.token.id,
          refreshHash: sha256(refreshToken),
          scope: pending.scope,
          createdAt: now.toISOString(),
          expiresAt: new Date(nowMs + REFRESH_TTL_MS).toISOString(),
        })
        .run();
      db.update(oauthClients)
        .set({ lastUsedAt: now.toISOString() })
        .where(eq(oauthClients.id, client.id))
        .run();
      return {
        access_token: created.raw,
        token_type: "Bearer" as const,
        expires_in: Math.floor(ACCESS_TTL_MS / 1000),
        refresh_token: refreshToken,
        scope: pending.scope,
      };
    });
  }

  /** Rotates both tokens. Fails once the grant's token was revoked (tokens page) or the grant expired. */
  function refresh(params: { refresh_token?: string; client_id?: string }): TokenAnswer {
    const nowMs = clock().getTime();
    const grant = params.refresh_token
      ? db
          .select()
          .from(oauthGrants)
          .where(eq(oauthGrants.refreshHash, sha256(params.refresh_token)))
          .get()
      : undefined;
    const invalid = new OAuthError(
      "invalid_grant",
      "The refresh token is unknown, revoked or expired. Connect again.",
    );
    if (!grant || grant.revokedAt !== null || Date.parse(grant.expiresAt) <= nowMs) throw invalid;
    if (params.client_id !== undefined && params.client_id !== grant.clientId) throw invalid;
    const token = db.select().from(apiTokens).where(eq(apiTokens.id, grant.tokenId)).get();
    if (!token || token.revokedAt !== null) {
      db.update(oauthGrants)
        .set({ revokedAt: new Date(nowMs).toISOString() })
        .where(eq(oauthGrants.id, grant.id))
        .run();
      throw invalid;
    }
    const raw = generateRawToken();
    const next = random(32);
    const now = new Date(nowMs).toISOString();
    db.transaction(() => {
      db.update(apiTokens)
        .set({
          tokenHash: hashToken(raw),
          prefix: raw.slice(0, TOKEN_PREFIX_LENGTH),
          expiresAt: new Date(nowMs + ACCESS_TTL_MS).toISOString(),
        })
        .where(eq(apiTokens.id, token.id))
        .run();
      db.update(oauthGrants)
        .set({
          refreshHash: sha256(next),
          refreshedAt: now,
          expiresAt: new Date(nowMs + REFRESH_TTL_MS).toISOString(),
        })
        .where(eq(oauthGrants.id, grant.id))
        .run();
      db.update(oauthClients).set({ lastUsedAt: now }).where(eq(oauthClients.id, grant.clientId)).run();
    });
    return {
      access_token: raw,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      refresh_token: next,
      scope: grant.scope,
    };
  }

  /** Token revocation (RFC 7009): a refresh token or an access token of a grant ends the grant. */
  function revoke(value: string | undefined): void {
    if (!value) return;
    const byRefresh = db
      .select()
      .from(oauthGrants)
      .where(eq(oauthGrants.refreshHash, sha256(value)))
      .get();
    const token = byRefresh
      ? undefined
      : db
          .select()
          .from(apiTokens)
          .where(eq(apiTokens.tokenHash, hashToken(value)))
          .get();
    const grant =
      byRefresh ??
      (token ? db.select().from(oauthGrants).where(eq(oauthGrants.tokenId, token.id)).get() : undefined);
    if (grant && grant.revokedAt === null) endGrant(grant);
  }

  return { approve, exchangeCode, refresh, revoke };
}

export type OAuth = ReturnType<typeof createOAuth>;
