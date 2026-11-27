import {
  API_PREFIX,
  AuthConfig,
  ChallengeOptions,
  Login,
  OidcCallback,
  OidcReauth,
  PasskeyLogin,
  Reauth,
  RecoveryCodes,
  Refresh,
  ResetLogin,
  ResetPasskeyOptions,
  SessionTokens,
  Setup,
  SetupPasskeyOptions,
  SetupResult,
  Signup,
  SignupPasskeyOptions,
  SignupResult,
} from "@organizer/shared";
import { ApiError } from "../http/errors.ts";
import { tooManyRequests } from "../http/rate-limit.ts";
import { authenticationOptions, listPasskeyRows } from "../services/auth/passkeys.ts";
import type { AuthServices } from "../services/auth/index.ts";
import { adminExists, prepareSetupCode } from "../services/auth/instance.ts";
import { passkeyLogin, passwordLogin, reauthenticate, refreshSession } from "../services/auth/login.ts";
import {
  resetLogin,
  resetPasskeyOptions,
  setup,
  setupPasskeyOptions,
  signup,
  signupPasskeyOptions,
} from "../services/auth/flows.ts";
import {
  localLoginEnded,
  omeldarBackchannelLogout,
  omeldarLink,
  omeldarLinkReady,
  omeldarReauth,
  omeldarSignIn,
} from "../services/auth/omeldar.ts";
import { revokeSession } from "../services/auth/sessions.ts";
import { accountRoutes } from "./account.ts";
import { adminRoutes } from "./admin.ts";
import { clientOf, sessionOf } from "./session.ts";
import type { App, Deps } from "./types.ts";

/**
 * Sign-in, account and admin routes. Registered by buildApp after the security hook. At start, while no
 * admin exists, it logs the setup code for the first admin (the only secret ever written to the log).
 */
export function registerAccountApi(app: App, deps: Deps, auth: AuthServices): void {
  // With SLOPPANIZER_AUTH=oidc the first admin comes from auth.omeldar.com, not a setup code.
  const code = auth.config.omeldar.mode === "oidc" ? null : prepareSetupCode(deps.db, auth.config.setupCode);
  if (code !== null) {
    const origin = auth.config.webOrigins[0] ?? "";
    app.log.warn(`No admin account yet. Open ${origin}/setup and enter the setup code: ${code}`);
  }
  authRoutes(app, deps, auth);
  accountRoutes(app, deps, auth);
  adminRoutes(app, deps, auth);
}

function authRoutes(app: App, deps: Deps, auth: AuthServices): void {
  const { db } = deps;
  const now = () => deps.clock().getTime();
  const publicConfig = { access: "public" as const };
  const sessionConfig = { access: "session" as const };
  const tags = ["auth"];
  const { omeldar } = auth.config;
  /**
   * The own login, sign-up, setup and reset: off while sign-in goes through auth.omeldar.com only, and
   * once SLOPPANIZER_LOCAL_LOGIN_UNTIL has passed.
   */
  const local = { access: "public" as const, localSignIn: true, localLogin: true };
  /** Sign-up: with omeldar on (both or oidc), new accounts are made at auth.omeldar.com only (S5#18). */
  const localSignupConfig = { ...local, localSignup: true };

  app.get(
    `${API_PREFIX}/auth/config`,
    {
      config: publicConfig,
      schema: {
        tags,
        summary: "Whether sign-ups are open and the first admin is still missing",
        response: { 200: AuthConfig },
      },
    },
    async () => {
      const ownLogin = omeldar.mode !== "oidc" && !localLoginEnded(omeldar, now());
      return {
        // With omeldar on, sign-up happens at auth.omeldar.com ("Create an account with omeldar").
        signupsOpen: auth.config.signupsOpen && ownLogin && omeldar.mode === "local",
        setupNeeded: ownLogin && !adminExists(db),
        rpId: auth.config.rpId,
        mode: omeldar.mode,
        omeldar:
          omeldar.mode === "local"
            ? null
            : {
                issuer: omeldar.issuer,
                clientId: omeldar.clientId,
                redirectUri: omeldar.redirectUri,
                accountUrl: `${omeldar.issuer}/account`,
              },
        localLoginEnds: omeldar.localLoginEnds
          ? { on: omeldar.localLoginEnds.on, at: omeldar.localLoginEnds.at.toISOString() }
          : null,
      };
    },
  );

  app.post(
    `${API_PREFIX}/auth/signup/passkey-options`,
    {
      config: localSignupConfig,
      schema: {
        tags,
        summary: "Passkey options for a sign-up without a password",
        body: SignupPasskeyOptions,
        response: { 200: ChallengeOptions },
      },
    },
    async (request) => signupPasskeyOptions(db, auth, request.body, request.ip),
  );
  app.post(
    `${API_PREFIX}/auth/signup`,
    {
      config: localSignupConfig,
      schema: {
        tags,
        summary: "Sign up; the account waits for an admin's approval",
        body: Signup,
        response: { 201: SignupResult },
      },
    },
    async (request, reply) => reply.status(201).send(await signup(db, auth, now(), request.body, request.ip)),
  );

  app.post(
    `${API_PREFIX}/auth/setup/passkey-options`,
    {
      config: local,
      schema: {
        tags,
        summary: "Passkey options for the first admin",
        body: SetupPasskeyOptions,
        response: { 200: ChallengeOptions },
      },
    },
    async (request) => setupPasskeyOptions(db, auth, request.body, request.ip),
  );
  app.post(
    `${API_PREFIX}/auth/setup`,
    {
      config: local,
      schema: {
        tags,
        summary: "Create the first admin with the setup code from the server log",
        body: Setup,
        response: { 201: SetupResult },
      },
    },
    async (request, reply) =>
      reply.status(201).send(await setup(db, auth, now(), request.body, clientOf(request))),
  );

  app.post(
    `${API_PREFIX}/auth/login`,
    {
      config: local,
      schema: {
        tags,
        summary: "Sign in with password plus authenticator or recovery code",
        body: Login,
        response: { 200: SessionTokens },
      },
    },
    async (request) => passwordLogin(db, auth, now(), request.body, clientOf(request)),
  );

  app.post(
    `${API_PREFIX}/auth/passkey/options`,
    {
      config: local,
      schema: {
        tags,
        summary: "Options for a passkey sign-in (any passkey of this site)",
        response: { 200: ChallengeOptions },
      },
    },
    async (request) => {
      const verdict = auth.limiters.passkeyOptionsByIp.take(request.ip);
      if (!verdict.ok) throw tooManyRequests(verdict.retryAfterSeconds);
      const { challenge, options } = await authenticationOptions(auth, null);
      return { challengeId: auth.challenges.add({ kind: "login", challenge }), options };
    },
  );
  app.post(
    `${API_PREFIX}/auth/passkey/login`,
    {
      config: local,
      schema: {
        tags,
        summary: "Sign in with a passkey",
        body: PasskeyLogin,
        response: { 200: SessionTokens },
      },
    },
    async (request) => passkeyLogin(db, auth, now(), request.body, clientOf(request), request.log),
  );

  app.post(
    `${API_PREFIX}/auth/refresh`,
    {
      config: publicConfig,
      schema: {
        tags,
        summary: "New access token; the refresh token rotates",
        body: Refresh,
        response: { 200: SessionTokens },
      },
    },
    async (request) => refreshSession(db, auth, now(), request.body.refreshToken, request.ip),
  );

  app.post(
    `${API_PREFIX}/auth/reset/passkey-options`,
    {
      config: local,
      schema: {
        tags,
        summary: "Passkey options for a login reset",
        body: ResetPasskeyOptions,
        response: { 200: ChallengeOptions },
      },
    },
    async (request) => resetPasskeyOptions(db, auth, now(), request.body, request.ip),
  );
  app.post(
    `${API_PREFIX}/auth/reset`,
    {
      config: local,
      schema: {
        tags,
        summary: "Set up a new login with the admin's reset code",
        body: ResetLogin,
        response: { 200: RecoveryCodes },
      },
    },
    async (request) => ({ recoveryCodes: await resetLogin(db, auth, now(), request.body, request.ip) }),
  );

  app.post(
    `${API_PREFIX}/auth/logout`,
    { config: sessionConfig, schema: { tags, summary: "Sign out this browser session" } },
    async (request, reply) => {
      const session = sessionOf(request);
      revokeSession(db, now(), session.accountId, session.sessionId, "logout");
      return reply.status(204).send();
    },
  );
  app.post(
    `${API_PREFIX}/auth/reauth/passkey-options`,
    {
      config: { ...sessionConfig, localSignIn: true },
      schema: {
        tags,
        summary: "Options to confirm it is you with a passkey of this account",
        response: { 200: ChallengeOptions },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const own = listPasskeyRows(db, session.accountId);
      if (own.length === 0)
        throw new ApiError("conflict", "This account has no passkey. Use your password and code.");
      const { challenge, options } = await authenticationOptions(auth, own);
      return {
        challengeId: auth.challenges.add({ kind: "reauth", challenge, ...session }),
        options,
      };
    },
  );
  app.post(
    `${API_PREFIX}/auth/reauth`,
    {
      config: { ...sessionConfig, localSignIn: true },
      schema: {
        tags,
        summary: "Confirm it is you before a sensitive action (valid 10 minutes)",
        body: Reauth,
      },
    },
    async (request, reply) => {
      const session = sessionOf(request);
      await reauthenticate(
        db,
        auth,
        now(),
        { id: session.sessionId, accountId: session.accountId },
        request.body,
        clientOf(request),
      );
      return reply.status(204).send();
    },
  );

  app.post(
    `${API_PREFIX}/auth/omeldar/callback`,
    {
      config: publicConfig,
      schema: {
        tags,
        summary: 'Finish "Sign in with omeldar": the callback\'s query and the pending sign-in',
        body: OidcCallback,
        response: { 200: SessionTokens },
      },
    },
    async (request) => omeldarSignIn(db, auth, now(), request.body, clientOf(request), deps.fallbackTimeZone),
  );
  app.post(
    `${API_PREFIX}/auth/omeldar/reauth`,
    {
      config: sessionConfig,
      schema: { tags, summary: "Confirm it is you with a fresh sign-in at omeldar", body: OidcReauth },
    },
    async (request, reply) => {
      const session = sessionOf(request);
      await omeldarReauth(
        db,
        auth,
        now(),
        { id: session.sessionId, accountId: session.accountId },
        request.body,
      );
      return reply.status(204).send();
    },
  );

  // Moving a signed-in account's sign-in to omeldar: needs a recent sign-in here (a stolen session must
  // not bind someone else's omeldar account), then a fresh sign-in at omeldar in a popup.
  app.post(
    `${API_PREFIX}/auth/omeldar/link/start`,
    {
      config: { ...sessionConfig, reauth: true },
      schema: { tags, summary: "Check that this account can move its sign-in to omeldar now" },
    },
    async (request, reply) => {
      omeldarLinkReady(db, auth, sessionOf(request).accountId);
      return reply.status(204).send();
    },
  );
  app.post(
    `${API_PREFIX}/auth/omeldar/link`,
    {
      config: { ...sessionConfig, reauth: true },
      schema: {
        tags,
        summary: "Move this account's sign-in to the omeldar account of a fresh sign-in there",
        body: OidcReauth,
      },
    },
    async (request, reply) => {
      await omeldarLink(db, auth, now(), { accountId: sessionOf(request).accountId }, request.body);
      return reply.status(204).send();
    },
  );

  // OpenID Connect back-channel logout: auth.omeldar.com posts a form with a signed logout_token.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string", bodyLimit: 16_384 },
      (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );
    scope.post(
      `${API_PREFIX}/auth/backchannel-logout`,
      { config: publicConfig, schema: { tags, summary: "Sign-out from auth.omeldar.com", hide: true } },
      async (request, reply) => {
        const token = (request.body as { logout_token?: unknown } | undefined)?.logout_token;
        if (typeof token !== "string" || token.length > 8192) {
          throw new ApiError("validation_failed", "Send logout_token as a form field.");
        }
        await omeldarBackchannelLogout(db, auth, now(), token);
        return reply.header("cache-control", "no-store").status(200).send();
      },
    );
  });
}
