import {
  API_PREFIX,
  type ChallengeOptions,
  MAX_PASSKEYS,
  normalizeOneTimeCode,
  type NewPasskey,
  type ResetLogin,
  type Setup,
  type SetupResult,
  type Signup,
  type SignupResult,
} from "@organizer/shared";
import { and, count, eq } from "drizzle-orm";
import { accounts, passkeys, recoveryCodes } from "../../db/auth-schema.ts";
import type { Db } from "../../db/index.ts";
import { ApiError } from "../../http/errors.ts";
import { unknownRouteBody } from "../../http/web.ts";
import { tooManyRequests } from "../../http/rate-limit.ts";
import {
  type AccountRow,
  findAccount,
  insertAccount,
  newWebauthnUserId,
  replaceRecoveryCodes,
  TOTP_PURPOSE,
} from "../accounts.ts";
import type { Tx } from "../context.ts";
import { seedAccount } from "../owned.ts";
import type { ChallengeKind } from "./challenges.ts";
import { isCommonPassword } from "./common-passwords.ts";
import { encryptSecret, safeEqual, sha256Hex } from "./crypto.ts";
import type { AuthServices } from "./index.ts";
import { adminExists, clearSetupCode, logAdminEvent, setupCodeMatches } from "./instance.ts";
import { type Client, startSession } from "./login.ts";
import { hashPassword } from "./password.ts";
import { insertPasskey, listPasskeyRows, registrationOptions, verifyRegistration } from "./passkeys.ts";
import { revokeAccountSessions } from "./sessions.ts";
import { clearFailures, nameKey } from "./throttle.ts";
import { verifyTotp } from "./totp.ts";

/**
 * Sign-up, first admin setup and the reset of a lost login. Each takes the new sign-in factors in one
 * request: a password with an authenticator (the client made the secret and proves it with a code), or a
 * passkey made for a challenge of the same flow. No half-made accounts exist on the server.
 */

export const MAX_PENDING_SIGNUPS = 50;
export const SIGNUP_EXPIRY_MS = 30 * 24 * 3600 * 1000;
export const RESET_CODE_TTL_MS = 24 * 3600 * 1000;

const SIGNUPS_PAUSED = "Sign-ups are paused right now. Try again later.";
const USERNAME_TAKEN = "That username is taken. Pick another.";
const WRONG_SETUP_CODE = "Wrong setup code. Use the code from the server log.";
export const WRONG_RESET = "Wrong username or reset code, or the code has expired.";
const CHALLENGE_GONE = "The passkey request has expired. Start again.";

const iso = (ms: number): string => new Date(ms).toISOString();

const limit = (verdict: { ok: boolean; retryAfterSeconds: number }): void => {
  if (!verdict.ok) throw tooManyRequests(verdict.retryAfterSeconds);
};

/** The server-side password rule on top of the shared ones. */
export function checkNewPassword(password: string): void {
  if (isCommonPassword(password)) {
    throw new ApiError(
      "validation_failed",
      "That password is on the lists of common passwords. Pick a longer, less common one.",
    );
  }
}

/** Proves the client's new authenticator secret with a code from it; returns the accepted step. */
export function proveTotp(secret: string, code: string, nowMs: number): number {
  const step = verifyTotp(secret, code, nowMs, null);
  if (step === null) {
    throw new ApiError(
      "validation_failed",
      "The code does not match the authenticator. Check the time on your phone and enter the newest code.",
    );
  }
  return step;
}

/** New sign-in factors, checked and ready to store. */
interface PreparedFactors {
  passwordHash: string | null;
  totpSecret: string | null;
  totpStep: number | null;
  passkey: { name: string; verified: Awaited<ReturnType<typeof verifyRegistration>> } | null;
  webauthnUserId: string | null;
}

type FactorInput = { password: string; totpSecret: string; totpCode: string } | { passkey: NewPasskey };

async function prepareFactors(
  auth: AuthServices,
  nowMs: number,
  kind: ChallengeKind,
  username: string,
  input: FactorInput,
): Promise<PreparedFactors> {
  if ("passkey" in input) {
    const challenge = auth.challenges.take(input.passkey.challengeId, kind);
    if (!challenge || challenge.username !== username || !challenge.webauthnUserId) {
      throw new ApiError("validation_failed", CHALLENGE_GONE);
    }
    const verified = await verifyRegistration(auth, challenge.challenge, input.passkey.response);
    return {
      passwordHash: null,
      totpSecret: null,
      totpStep: null,
      passkey: { name: input.passkey.name, verified },
      webauthnUserId: challenge.webauthnUserId,
    };
  }
  checkNewPassword(input.password);
  const totpStep = proveTotp(input.totpSecret, input.totpCode, nowMs);
  return {
    passwordHash: await hashPassword(input.password),
    totpSecret: input.totpSecret,
    totpStep,
    passkey: null,
    webauthnUserId: null,
  };
}

const pendingCount = (tx: Tx): number =>
  tx.select({ n: count() }).from(accounts).where(eq(accounts.status, "pending")).get()?.n ?? 0;

function assertSignupsOpen(db: Db, auth: AuthServices): void {
  if (!auth.config.signupsOpen || pendingCount(db) >= MAX_PENDING_SIGNUPS) {
    throw new ApiError("forbidden", SIGNUPS_PAUSED);
  }
}

function assertUsernameFree(tx: Tx, username: string): void {
  if (findAccount(tx, username)) throw new ApiError("conflict", USERNAME_TAKEN);
}

async function newAccountOptions(
  auth: AuthServices,
  kind: ChallengeKind,
  username: string,
  displayName: string,
  webauthnUserId: string,
  existing: Parameters<typeof registrationOptions>[2] = [],
): Promise<ChallengeOptions> {
  const { challenge, options } = await registrationOptions(
    auth,
    { username, displayName, webauthnUserId },
    existing,
  );
  const challengeId = auth.challenges.add({ kind, challenge, username, displayName, webauthnUserId });
  return { challengeId, options };
}

// ---------------------------------------------------------------------------------------------------------
// Sign-up

/** POST /auth/signup/passkey-options. */
export async function signupPasskeyOptions(
  db: Db,
  auth: AuthServices,
  input: { username: string; displayName: string },
  ip: string,
): Promise<ChallengeOptions> {
  limit(auth.limiters.passkeyOptionsByIp.take(ip));
  assertSignupsOpen(db, auth);
  assertUsernameFree(db, input.username);
  return newAccountOptions(auth, "signup", input.username, input.displayName, newWebauthnUserId());
}

/** POST /auth/signup: a pending account with its factors and 10 recovery codes. */
export async function signup(
  db: Db,
  auth: AuthServices,
  nowMs: number,
  input: Signup,
  ip: string,
): Promise<SignupResult> {
  limit(auth.limiters.signupByIp.take(ip));
  assertSignupsOpen(db, auth);
  assertUsernameFree(db, input.username);
  const factors = await prepareFactors(auth, nowMs, "signup", input.username, input);
  const nowIso = iso(nowMs);
  const codes = db.transaction((tx) => {
    assertUsernameFree(tx, input.username);
    const account = insertAccount(tx, auth.dataKey, nowIso, {
      username: input.username,
      displayName: input.displayName,
      timeZone: input.timeZone,
      ...(input.region ? { region: input.region } : {}),
      status: "pending",
      note: input.note ?? "",
      passwordHash: factors.passwordHash,
      totpSecret: factors.totpSecret,
      totpStep: factors.totpStep,
      ...(factors.webauthnUserId ? { webauthnUserId: factors.webauthnUserId } : {}),
    });
    if (factors.passkey)
      insertPasskey(tx, account.id, nowIso, factors.passkey.name, factors.passkey.verified);
    logAdminEvent(tx, nowIso, "system", "signup", account.username);
    return replaceRecoveryCodes(tx, account.id, nowIso);
  });
  return { status: "pending", recoveryCodes: codes };
}

// ---------------------------------------------------------------------------------------------------------
// First admin

/** Once an admin exists, the setup routes answer like routes that do not exist. */
const setupGone = (path: string): ApiError =>
  new ApiError("not_found", unknownRouteBody("POST", `${API_PREFIX}${path}`).error.message);

function checkSetup(db: Db, auth: AuthServices, setupCode: string, ip: string, path: string): void {
  if (adminExists(db)) throw setupGone(path);
  limit(auth.limiters.setupByIp.take(ip));
  if (!setupCodeMatches(db, setupCode)) throw new ApiError("unauthorized", WRONG_SETUP_CODE);
}

/** POST /auth/setup/passkey-options. */
export async function setupPasskeyOptions(
  db: Db,
  auth: AuthServices,
  input: { setupCode: string; username: string; displayName: string },
  ip: string,
): Promise<ChallengeOptions> {
  checkSetup(db, auth, input.setupCode, ip, "/auth/setup/passkey-options");
  return newAccountOptions(auth, "setup", input.username, input.displayName, newWebauthnUserId());
}

/** POST /auth/setup: the first admin, active, seeded and signed in. */
export async function setup(
  db: Db,
  auth: AuthServices,
  nowMs: number,
  input: Setup,
  client: Client,
): Promise<SetupResult> {
  checkSetup(db, auth, input.setupCode, client.ip, "/auth/setup");
  const factors = await prepareFactors(auth, nowMs, "setup", input.username, input);
  const nowIso = iso(nowMs);
  const { account, codes } = db.transaction((tx) => {
    if (adminExists(tx)) throw setupGone("/auth/setup");
    assertUsernameFree(tx, input.username);
    const row = insertAccount(tx, auth.dataKey, nowIso, {
      username: input.username,
      displayName: input.displayName,
      timeZone: input.timeZone,
      ...(input.region ? { region: input.region } : {}),
      status: "active",
      role: "admin",
      passwordHash: factors.passwordHash,
      totpSecret: factors.totpSecret,
      totpStep: factors.totpStep,
      ...(factors.webauthnUserId ? { webauthnUserId: factors.webauthnUserId } : {}),
    });
    if (factors.passkey) insertPasskey(tx, row.id, nowIso, factors.passkey.name, factors.passkey.verified);
    seedAccount(tx, row.id, nowIso);
    clearSetupCode(tx);
    logAdminEvent(tx, nowIso, row.username, "setup_admin", row.username);
    return { account: row, codes: replaceRecoveryCodes(tx, row.id, nowIso) };
  });
  return { recoveryCodes: codes, session: startSession(db, auth, nowMs, account, "setup", client) };
}

// ---------------------------------------------------------------------------------------------------------
// Reset of a lost login (the admin made a reset code)

/** The account whose reset code this is, still valid; 401 otherwise (same answer for every reason). */
function checkResetCode(
  db: Db,
  auth: AuthServices,
  nowMs: number,
  username: string,
  resetCode: string,
  ip: string,
): AccountRow {
  limit(auth.limiters.resetByIp.take(ip));
  limit(auth.limiters.resetByName.take(nameKey(username)));
  const account = findAccount(db, username);
  const typed = sha256Hex(normalizeOneTimeCode(resetCode));
  const stored = account?.resetCodeHash ?? sha256Hex("no reset code");
  const matches = safeEqual(typed, stored);
  const valid =
    account !== undefined &&
    account.resetCodeHash !== null &&
    account.resetExpiresAt !== null &&
    Date.parse(account.resetExpiresAt) > nowMs;
  if (!matches || !valid) throw new ApiError("unauthorized", WRONG_RESET);
  return account;
}

/** POST /auth/reset/passkey-options. */
export async function resetPasskeyOptions(
  db: Db,
  auth: AuthServices,
  nowMs: number,
  input: { username: string; resetCode: string },
  ip: string,
): Promise<ChallengeOptions> {
  const account = checkResetCode(db, auth, nowMs, input.username, input.resetCode, ip);
  return newAccountOptions(auth, "reset", account.username, account.displayName, account.webauthnUserId);
}

/** POST /auth/reset: new factors and recovery codes; the person then signs in. */
export async function resetLogin(
  db: Db,
  auth: AuthServices,
  nowMs: number,
  input: ResetLogin,
  ip: string,
): Promise<string[]> {
  const account = checkResetCode(db, auth, nowMs, input.username, input.resetCode, ip);
  const factors = await prepareFactors(auth, nowMs, "reset", account.username, input);
  const nowIso = iso(nowMs);
  return db.transaction((tx) => {
    // Used once: a second request with the same code finds it gone.
    const cleared = tx
      .update(accounts)
      .set({
        passwordHash: factors.passwordHash,
        passwordChangedAt: factors.passwordHash ? nowIso : null,
        totpSecretEnc: factors.totpSecret
          ? encryptSecret(auth.dataKey, factors.totpSecret, TOTP_PURPOSE)
          : null,
        totpLastStep: factors.totpStep,
        totpSince: factors.totpSecret ? nowIso : null,
        resetCodeHash: null,
        resetExpiresAt: null,
        updatedAt: nowIso,
      })
      .where(and(eq(accounts.id, account.id), eq(accounts.resetCodeHash, account.resetCodeHash as string)))
      .run();
    if (cleared.changes === 0) throw new ApiError("unauthorized", WRONG_RESET);
    if (factors.passkey)
      insertPasskey(tx, account.id, nowIso, factors.passkey.name, factors.passkey.verified);
    clearFailures(tx, nameKey(account.username));
    return replaceRecoveryCodes(tx, account.id, nowIso);
  });
}

/**
 * The admin's "Reset login": clears password, authenticator, passkeys and recovery codes, signs out every
 * session and returns a reset code valid 24 hours (only its hash is stored). Data and API tokens stay.
 */
export function startLoginReset(tx: Tx, nowMs: number, account: AccountRow, newCode: string): string {
  const nowIso = iso(nowMs);
  const expiresAt = iso(nowMs + RESET_CODE_TTL_MS);
  tx.update(accounts)
    .set({
      passwordHash: null,
      passwordChangedAt: null,
      totpSecretEnc: null,
      totpLastStep: null,
      totpSince: null,
      resetCodeHash: sha256Hex(normalizeOneTimeCode(newCode)),
      resetExpiresAt: expiresAt,
      loginResetAt: nowIso,
      updatedAt: nowIso,
    })
    .where(eq(accounts.id, account.id))
    .run();
  tx.delete(passkeys).where(eq(passkeys.accountId, account.id)).run();
  tx.delete(recoveryCodes).where(eq(recoveryCodes.accountId, account.id)).run();
  revokeAccountSessions(tx, nowMs, account.id, "reset");
  return expiresAt;
}

/** Registration options for one more passkey of a signed-in account. */
export async function addPasskeyOptions(
  db: Db,
  auth: AuthServices,
  account: AccountRow,
  sessionId: string,
): Promise<ChallengeOptions> {
  const existing = listPasskeyRows(db, account.id);
  if (existing.length >= MAX_PASSKEYS) {
    throw new ApiError(
      "conflict",
      `This account has ${MAX_PASSKEYS} passkeys, the most it can have. Remove one you no longer use.`,
    );
  }
  const { challenge, options } = await registrationOptions(
    auth,
    { username: account.username, displayName: account.displayName, webauthnUserId: account.webauthnUserId },
    existing,
  );
  const challengeId = auth.challenges.add({ kind: "register", challenge, accountId: account.id, sessionId });
  return { challengeId, options };
}
