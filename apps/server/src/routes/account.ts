import {
  AccountProfile,
  API_PREFIX,
  ChallengeOptions,
  ChangePassword,
  ConfirmUsername,
  Passkey,
  PasskeyIdParams,
  passwordProblem,
  RecoveryCodes,
  RegisterPasskey,
  RenamePasskey,
  ReplaceTotp,
  RevokedSessions,
  SessionIdParams,
  SessionInfo,
  UpdateAccount,
} from "@organizer/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { accounts } from "../db/auth-schema.ts";
import { ApiError } from "../http/errors.ts";
import {
  type AccountRow,
  deleteAccount,
  getAccount,
  otherActiveAdmin,
  replaceRecoveryCodes,
  TOTP_PURPOSE,
  toProfile,
  updateAccount,
} from "../services/accounts.ts";
import { encryptSecret } from "../services/auth/crypto.ts";
import { addPasskeyOptions, checkNewPassword, proveTotp } from "../services/auth/flows.ts";
import type { AuthServices } from "../services/auth/index.ts";
import { logAdminEvent } from "../services/auth/instance.ts";
import { SESSION_ENDED } from "../services/auth/login.ts";
import { hashPassword } from "../services/auth/password.ts";
import {
  countPasskeys,
  deletePasskey,
  findPasskey,
  insertPasskey,
  listPasskeyRows,
  renamePasskey,
  toPasskey,
  verifyRegistration,
} from "../services/auth/passkeys.ts";
import { listSessions, revokeAccountSessions, revokeSession } from "../services/auth/sessions.ts";
import { sessionOf } from "./session.ts";
import type { App, Deps } from "./types.ts";

const passkeyNotFound = (id: string) =>
  new ApiError("not_found", `Passkey ${id} does not exist. Check the id.`);

/** The signed-in person's own account: profile, sign-in factors, sessions, delete. Browser session only. */
export function accountRoutes(app: App, deps: Deps, auth: AuthServices): void {
  const { db } = deps;
  const nowMs = () => deps.clock().getTime();
  const nowIso = () => deps.clock().toISOString();
  const config = { access: "session" as const };
  const sensitive = { access: "session" as const, reauth: true };
  const tags = ["account"];

  /** The caller's account row (the security hook checked it is active). */
  const me = (request: Parameters<typeof sessionOf>[0]): { row: AccountRow; sessionId: string } => {
    const session = sessionOf(request);
    const row = getAccount(db, session.accountId);
    if (!row) throw new ApiError("unauthorized", SESSION_ENDED);
    return { row, sessionId: session.sessionId };
  };

  app.get(
    `${API_PREFIX}/account`,
    {
      config,
      schema: { tags, summary: "Your account and how you sign in", response: { 200: AccountProfile } },
    },
    async (request) => toProfile(db, me(request).row),
  );
  app.patch(
    `${API_PREFIX}/account`,
    {
      config,
      schema: {
        tags,
        summary: "Change name, color, time zone, formats or how projects open",
        body: UpdateAccount,
        response: { 200: AccountProfile },
      },
    },
    async (request) => {
      const { row } = me(request);
      updateAccount(db, row.id, nowIso(), request.body);
      return toProfile(db, getAccount(db, row.id) as AccountRow);
    },
  );

  app.post(
    `${API_PREFIX}/account/password`,
    {
      config: { ...sensitive, localSignIn: true },
      schema: { tags, summary: "Set a new password; other sessions are signed out", body: ChangePassword },
    },
    async (request, reply) => {
      const { row, sessionId } = me(request);
      const body = request.body;
      const problem = passwordProblem(body.newPassword, row.username);
      if (problem) throw new ApiError("validation_failed", problem);
      checkNewPassword(body.newPassword);
      const hasTotp = row.totpSecretEnc !== null;
      if (!hasTotp && body.totpSecret === undefined) {
        throw new ApiError(
          "validation_failed",
          "Set up an authenticator together with the password: a password always needs a code.",
        );
      }
      if (hasTotp && body.totpSecret !== undefined) {
        throw new ApiError("validation_failed", "Replace the authenticator in its own step.");
      }
      const step =
        body.totpSecret !== undefined && body.totpCode !== undefined
          ? proveTotp(body.totpSecret, body.totpCode, nowMs())
          : null;
      const hash = await hashPassword(body.newPassword);
      const at = nowIso();
      db.transaction((tx) => {
        tx.update(accounts)
          .set({
            passwordHash: hash,
            passwordChangedAt: at,
            updatedAt: at,
            ...(body.totpSecret !== undefined
              ? {
                  totpSecretEnc: encryptSecret(auth.dataKey, body.totpSecret, TOTP_PURPOSE),
                  totpLastStep: step,
                  totpSince: at,
                }
              : {}),
          })
          .where(eq(accounts.id, row.id))
          .run();
        revokeAccountSessions(tx, nowMs(), row.id, "password_changed", sessionId);
      });
      return reply.status(204).send();
    },
  );

  app.post(
    `${API_PREFIX}/account/totp`,
    {
      config: { ...sensitive, localSignIn: true },
      schema: {
        tags,
        summary: "Replace the authenticator (prove the new one with a code)",
        body: ReplaceTotp,
      },
    },
    async (request, reply) => {
      const { row } = me(request);
      if (row.passwordHash === null) {
        throw new ApiError(
          "conflict",
          "Set a password first: the authenticator code works together with a password.",
        );
      }
      const step = proveTotp(request.body.totpSecret, request.body.totpCode, nowMs());
      const at = nowIso();
      db.update(accounts)
        .set({
          totpSecretEnc: encryptSecret(auth.dataKey, request.body.totpSecret, TOTP_PURPOSE),
          totpLastStep: step,
          totpSince: at,
          updatedAt: at,
        })
        .where(eq(accounts.id, row.id))
        .run();
      return reply.status(204).send();
    },
  );

  app.post(
    `${API_PREFIX}/account/recovery-codes`,
    {
      config: { ...sensitive, localSignIn: true },
      schema: {
        tags,
        summary: "New recovery codes (the old ones stop working)",
        response: { 200: RecoveryCodes },
      },
    },
    async (request) => ({
      recoveryCodes: db.transaction((tx) => replaceRecoveryCodes(tx, me(request).row.id, nowIso())),
    }),
  );

  app.get(
    `${API_PREFIX}/account/passkeys`,
    { config, schema: { tags, summary: "Your passkeys", response: { 200: z.array(Passkey) } } },
    async (request) => listPasskeyRows(db, me(request).row.id).map(toPasskey),
  );
  app.post(
    `${API_PREFIX}/account/passkeys/options`,
    {
      config: { ...sensitive, localSignIn: true },
      schema: { tags, summary: "Options to add a passkey", response: { 200: ChallengeOptions } },
    },
    async (request) => {
      const { row, sessionId } = me(request);
      return addPasskeyOptions(db, auth, row, sessionId);
    },
  );
  app.post(
    `${API_PREFIX}/account/passkeys`,
    {
      config: { ...config, localSignIn: true },
      schema: {
        tags,
        summary: "Add a passkey made for the options",
        body: RegisterPasskey,
        response: { 201: Passkey },
      },
    },
    async (request, reply) => {
      const { row, sessionId } = me(request);
      const challenge = auth.challenges.take(request.body.challengeId, "register", {
        accountId: row.id,
        sessionId,
      });
      if (!challenge)
        throw new ApiError("validation_failed", "The passkey request has expired. Start again.");
      const verified = await verifyRegistration(auth, challenge.challenge, request.body.response);
      const saved = db.transaction((tx) => insertPasskey(tx, row.id, nowIso(), request.body.name, verified));
      return reply.status(201).send(toPasskey(saved));
    },
  );
  app.patch(
    `${API_PREFIX}/account/passkeys/:id`,
    {
      config,
      schema: {
        tags,
        summary: "Rename a passkey",
        params: PasskeyIdParams,
        body: RenamePasskey,
        response: { 200: Passkey },
      },
    },
    async (request) => {
      const saved = renamePasskey(db, me(request).row.id, request.params.id, request.body.name);
      if (!saved) throw passkeyNotFound(request.params.id);
      return toPasskey(saved);
    },
  );
  app.delete(
    `${API_PREFIX}/account/passkeys/:id`,
    { config: sensitive, schema: { tags, summary: "Remove a passkey", params: PasskeyIdParams } },
    async (request, reply) => {
      const { row } = me(request);
      db.transaction((tx) => {
        if (!findPasskey(tx, row.id, request.params.id)) throw passkeyNotFound(request.params.id);
        if (row.passwordHash === null && countPasskeys(tx, row.id) <= 1) {
          throw new ApiError(
            "conflict",
            "This passkey is your only way to sign in. Add another passkey or a password first.",
          );
        }
        deletePasskey(tx, row.id, request.params.id);
      });
      return reply.status(204).send();
    },
  );

  app.get(
    `${API_PREFIX}/account/sessions`,
    { config, schema: { tags, summary: "Where you are signed in", response: { 200: z.array(SessionInfo) } } },
    async (request) => {
      const { row, sessionId } = me(request);
      return listSessions(db, nowMs(), row.id, sessionId);
    },
  );
  app.delete(
    `${API_PREFIX}/account/sessions/:id`,
    { config, schema: { tags, summary: "Sign out one session", params: SessionIdParams } },
    async (request, reply) => {
      const { row } = me(request);
      if (!revokeSession(db, nowMs(), row.id, request.params.id, "other_logout")) {
        throw new ApiError("not_found", `Session ${request.params.id} does not exist. Check the id.`);
      }
      return reply.status(204).send();
    },
  );
  app.delete(
    `${API_PREFIX}/account/sessions`,
    { config, schema: { tags, summary: "Sign out every other session", response: { 200: RevokedSessions } } },
    async (request) => {
      const { row, sessionId } = me(request);
      return { revoked: revokeAccountSessions(db, nowMs(), row.id, "other_logout", sessionId) };
    },
  );

  app.delete(
    `${API_PREFIX}/account`,
    {
      config: sensitive,
      schema: { tags, summary: "Delete your account with all its data", body: ConfirmUsername },
    },
    async (request, reply) => {
      const { row } = me(request);
      if (request.body.confirmUsername !== row.username) {
        throw new ApiError("validation_failed", "Type your username to confirm the delete.");
      }
      if (row.role === "admin" && !otherActiveAdmin(db, row.id)) {
        throw new ApiError("conflict", "Make another account admin first.");
      }
      deleteAccount(db, auth.config, row, (tx) =>
        logAdminEvent(tx, nowIso(), row.username, "delete", row.username),
      );
      return reply.status(204).send();
    },
  );
}
