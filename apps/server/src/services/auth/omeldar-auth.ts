/**
 * omeldar-auth client: sign in with auth.omeldar.com from any site. Zero dependencies, standard WebCrypto
 * and fetch, so it runs in Node 20+, Deno, Bun, workers and browsers. Copy this one file into a site.
 *
 *   const auth = createAuthClient({
 *     issuer: "https://auth.omeldar.com",
 *     clientId: "racing",
 *     clientSecret: process.env.AUTH_CLIENT_SECRET,     // server-side sites; leave out in a browser
 *     redirectUri: "https://racing.omeldar.com/auth/callback",
 *   });
 *
 *   // 1. Sign-in button: keep `pending` (a short-lived HttpOnly cookie, or sessionStorage), then redirect.
 *   const { url, pending } = await auth.signIn();
 *
 *   // 2. Callback route: tokens and the checked id token claims.
 *   const { user, tokens } = await auth.callback(callbackUrl, pending);
 *   // user.sub (stable id), user.preferred_username, user.name, user.app_role, user.legacy_id, user.acr ...
 *
 * See docs/INTEGRATION.md for the whole picture (sessions, logout, Sloppanizer's old ids).
 */

export interface AuthClientOptions {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  /** Default "openid profile email". */
  scope?: string;
  fetch?: typeof fetch;
}

export interface SignInOptions {
  /** "login": always ask again (e.g. before a sensitive action). "none": only if already signed in. "create": open sign-up. */
  prompt?: "login" | "none" | "create";
  /** Seconds: ask again when the last sign-in is older. */
  maxAge?: number;
  loginHint?: string;
}

/** What the site keeps between signIn() and callback(). Not secret from the person, but must not be forged: keep it in an HttpOnly cookie or sessionStorage. */
export interface Pending {
  state: string;
  nonce: string;
  verifier: string;
  maxAge?: number;
}

export interface Tokens {
  access_token: string;
  id_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: "Bearer";
  scope: string;
}

export interface User {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  auth_time: number;
  sid: string;
  /** How the person signed in: pwd, otp (authenticator), email, rcv (recovery code), hwk (passkey). */
  amr: string[];
  /** "mfa" when a passkey or a second step was used, else "pwd". */
  acr: "mfa" | "pwd";
  preferred_username: string;
  name?: string;
  email?: string;
  email_verified?: boolean;
  /** The person's role on this site, set by the admin on auth.omeldar.com. */
  app_role: "user" | "admin";
  /** The id of the person's account on this site from before auth.omeldar.com (imported accounts). */
  legacy_id?: string;
  nonce?: string;
  [claim: string]: unknown;
}

export class AuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const enc = new TextEncoder();
const b64u = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64u = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const random = (bytes = 32): string => b64u(crypto.getRandomValues(new Uint8Array(bytes)));

export function createAuthClient(opts: AuthClientOptions) {
  const issuer = opts.issuer.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const scope = opts.scope ?? "openid profile email";
  let jwks: { keys: (JsonWebKey & { kid: string })[]; at: number } | null = null;

  async function keyFor(kid: string): Promise<CryptoKey> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!jwks || Date.now() - jwks.at > 3600_000 || attempt === 1) {
        const res = await doFetch(`${issuer}/jwks.json`);
        if (!res.ok) throw new AuthError("jwks", `Cannot load ${issuer}/jwks.json (${res.status}).`);
        jwks = { ...(await res.json()), at: Date.now() };
      }
      const jwk = jwks!.keys.find((k) => k.kid === kid);
      if (jwk) return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    }
    throw new AuthError("jwks", "The token was signed with an unknown key.");
  }

  /** Checks the signature, issuer, audience, expiry and type of a token from auth.omeldar.com. */
  async function verifyJwt(token: string, typ: "JWT" | "at+jwt" | "logout+jwt"): Promise<Record<string, unknown>> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new AuthError("invalid_token", "Not a JWT.");
    const [h, p, s] = parts as [string, string, string];
    const header = JSON.parse(new TextDecoder().decode(fromB64u(h))) as { alg: string; kid: string; typ: string };
    if (header.alg !== "ES256" || header.typ !== typ) throw new AuthError("invalid_token", "Unexpected token type.");
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await keyFor(header.kid), fromB64u(s), enc.encode(`${h}.${p}`));
    if (!ok) throw new AuthError("invalid_token", "Bad signature.");
    const claims = JSON.parse(new TextDecoder().decode(fromB64u(p))) as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== issuer) throw new AuthError("invalid_token", "Wrong issuer.");
    if (claims.aud !== opts.clientId) throw new AuthError("invalid_token", "Token is for another site.");
    if (typeof claims.exp !== "number" || claims.exp < now - 60) throw new AuthError("invalid_token", "Token expired.");
    return claims;
  }

  async function token(body: Record<string, string>): Promise<Tokens> {
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (opts.clientSecret) headers.authorization = `Basic ${btoa(`${encodeURIComponent(opts.clientId)}:${encodeURIComponent(opts.clientSecret)}`)}`;
    else body.client_id = opts.clientId;
    const res = await doFetch(`${issuer}/token`, { method: "POST", headers, body: new URLSearchParams(body) });
    const json = (await res.json().catch(() => ({}))) as Record<string, string>;
    if (!res.ok) throw new AuthError(json.error ?? "token_error", json.error_description ?? `Token request failed (${res.status}).`);
    return json as unknown as Tokens;
  }

  return {
    /** The URL to send the browser to, and what to keep until the callback. */
    async signIn(o: SignInOptions = {}): Promise<{ url: string; pending: Pending }> {
      const pending: Pending = { state: random(16), nonce: random(16), verifier: random(32), ...(o.maxAge !== undefined ? { maxAge: o.maxAge } : {}) };
      const challenge = b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(pending.verifier))));
      const q = new URLSearchParams({ client_id: opts.clientId, redirect_uri: opts.redirectUri, response_type: "code", scope, state: pending.state, nonce: pending.nonce, code_challenge: challenge, code_challenge_method: "S256" });
      if (o.prompt) q.set("prompt", o.prompt);
      if (o.maxAge !== undefined) q.set("max_age", String(o.maxAge));
      if (o.loginHint) q.set("login_hint", o.loginHint);
      return { url: `${issuer}/authorize?${q}`, pending };
    },

    /** Handles the callback URL (or its query): checks state and issuer, gets tokens, checks the id token. */
    async callback(callback: string | URL | URLSearchParams, pending: Pending): Promise<{ user: User; tokens: Tokens }> {
      const q = callback instanceof URLSearchParams ? callback : new URL(String(callback), "http://x").searchParams;
      if (q.get("state") !== pending.state) throw new AuthError("state_mismatch", "The sign-in answer does not belong to this browser. Start again.");
      if (q.get("error")) throw new AuthError(q.get("error")!, q.get("error_description") ?? "Sign-in failed.");
      if (q.get("iss") && q.get("iss") !== issuer) throw new AuthError("issuer_mismatch", "The answer came from another issuer.");
      const code = q.get("code");
      if (!code) throw new AuthError("no_code", "No code in the callback.");
      const tokens = await token({ grant_type: "authorization_code", code, code_verifier: pending.verifier, redirect_uri: opts.redirectUri });
      const user = (await verifyJwt(tokens.id_token, "JWT")) as User;
      if (user.nonce !== pending.nonce) throw new AuthError("nonce_mismatch", "The id token does not belong to this sign-in.");
      if (pending.maxAge !== undefined && Date.now() / 1000 - user.auth_time > pending.maxAge + 60) throw new AuthError("stale", "The sign-in is older than asked for.");
      return { user, tokens };
    },

    /** New tokens (the old refresh token stops working; keep the new one). Fails when the person was signed out or disabled. */
    async refresh(refreshToken: string): Promise<{ user: User; tokens: Tokens }> {
      const tokens = await token({ grant_type: "refresh_token", refresh_token: refreshToken });
      return { user: (await verifyJwt(tokens.id_token, "JWT")) as User, tokens };
    },

    /** For APIs: checks an access token sent as `Authorization: Bearer ...` (no call to the auth server). */
    async verifyAccessToken(accessToken: string): Promise<User & { scope: string; client_id: string }> {
      return (await verifyJwt(accessToken, "at+jwt")) as User & { scope: string; client_id: string };
    },

    /** For the back-channel logout route (POST, form field logout_token): who to sign out. */
    async verifyLogoutToken(logoutToken: string): Promise<{ sub: string; sid?: string }> {
      const c = await verifyJwt(logoutToken, "logout+jwt");
      const events = c.events as Record<string, unknown> | undefined;
      if (!events?.["http://schemas.openid.net/event/backchannel-logout"] || typeof c.sub !== "string") throw new AuthError("invalid_token", "Not a logout token.");
      return { sub: c.sub, ...(typeof c.sid === "string" ? { sid: c.sid } : {}) };
    },

    /** Ends the refresh token at the auth server (when the person signs out of this site). */
    async revoke(refreshToken: string): Promise<void> {
      const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
      const body: Record<string, string> = { token: refreshToken };
      if (opts.clientSecret) headers.authorization = `Basic ${btoa(`${encodeURIComponent(opts.clientId)}:${encodeURIComponent(opts.clientSecret)}`)}`;
      else body.client_id = opts.clientId;
      await doFetch(`${issuer}/revoke`, { method: "POST", headers, body: new URLSearchParams(body) });
    },

    /** Signs the person out of every omeldar site and comes back to `postLogoutRedirectUri` (must be registered). */
    logoutUrl(o: { idTokenHint?: string; postLogoutRedirectUri?: string; state?: string } = {}): string {
      const q = new URLSearchParams({ client_id: opts.clientId });
      if (o.idTokenHint) q.set("id_token_hint", o.idTokenHint);
      if (o.postLogoutRedirectUri) q.set("post_logout_redirect_uri", o.postLogoutRedirectUri);
      if (o.state) q.set("state", o.state);
      return `${issuer}/logout?${q}`;
    },

    /** The account page, for a "Manage account" link. */
    accountUrl: `${issuer}/account`,
  };
}

export type AuthClient = ReturnType<typeof createAuthClient>;
