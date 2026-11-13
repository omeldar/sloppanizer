import type { Login, Reauth, SessionMethod, SessionTokens } from "@organizer/shared";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { accounts } from "../../db/auth-schema.ts";
import type { Db } from "../../db/index.ts";
import { ApiError } from "../../http/errors.ts";
import { tooManyRequests, waitText } from "../../http/rate-limit.ts";
import {
  type AccountRow,
  findAccount,
  getAccount,
  recoveryCodesLeft,
  TOTP_PURPOSE,
  useRecoveryCode,
} from "../accounts.ts";
import type { Tx } from "../context.ts";
import { DecryptError, decryptSecret } from "./crypto.ts";
import type { AuthServices } from "./index.ts";
import { hashPassword, verifyPassword } from "./password.ts";
import { markPasskeyUsed, verifyAssertion } from "./passkeys.ts";
import {
  createSession,
  markAuthenticated,
  rotateRefreshToken,
  type SessionRow,
  sessionTokens,
} from "./sessions.ts";
import { clearFailures, lockedFor, nameKey, recordFailure } from "./throttle.ts";
import { verifyTotp } from "./totp.ts";

/**
 * Checking sign-in factors and starting sessions. Every wrong part of a login gets the same answer on
 * the same path (the password hash runs also for unknown names), failures count against the typed
 * name and the IP, and a factor is used up (authenticator step, recovery code) only when all parts fit.
 */

/** Who is calling (for the session row and the per-IP limits). */
export interface Client {
  ip: string;
  userAgent: string;
}

export const WRONG_LOGIN = "Wrong username, password or code.";
export const WRONG_REAUTH = "Wrong password or code.";
export const SESSION_ENDED = "Your session has ended. Sign in again.";
const PASSKEY_LOGIN_FAILED = "That passkey did not sign you in. Try again, or use your password and code.";

const iso = (ms: number): string => new Date(ms).toISOString();

export const accountStateError = (account: AccountRow): ApiError | null => {
  if (account.status === "pending") {
    return new ApiError("forbidden", "Your account waits for approval.", { reason: "pending" });
  }
  if (account.status === "disabled") {
    return new ApiError("forbidden", "This account is disabled. Ask the admin.", { reason: "disabled" });
  }
  return null;
};

const lockError = (seconds: number): ApiError =>
  tooManyRequests(seconds, `Too many attempts. Try again in ${waitText(seconds)}.`);

/** Refuses with 429 while the IP or the name is blocked. */
function checkBlocks(db: Db, auth: AuthServices, nowMs: number, key: string, ip: string): void {
  const ipVerdict = auth.limiters.loginFailuresByIp.check(ip);
  if (!ipVerdict.ok) throw lockError(ipVerdict.retryAfterSeconds);
  const seconds = lockedFor(db, key, nowMs);
  if (seconds > 0) throw lockError(seconds);
}

function countFailure(db: Db, auth: AuthServices, nowMs: number, key: string, ip: string): void {
  recordFailure(db, key, nowMs);
  auth.limiters.loginFailuresByIp.take(ip);
}

/** The decrypted authenticator secret, or null (none, or the data key changed). */
export function totpSecretOf(auth: AuthServices, account: AccountRow): string | null {
  if (!account.totpSecretEnc) return null;
  try {
    return decryptSecret(auth.dataKey, account.totpSecretEnc, TOTP_PURPOSE);
  } catch (error) {
    if (error instanceof DecryptError) return null;
    throw error;
  }
}

/** Records an accepted authenticator step; false when another request used it first. */
function useTotpStep(tx: Tx, accountId: number, step: number): boolean {
  return (
    tx
      .update(accounts)
      .set({ totpLastStep: step })
      .where(
        and(eq(accounts.id, accountId), or(isNull(accounts.totpLastStep), lt(accounts.totpLastStep, step))),
      )
      .run().changes > 0
  );
}

type Factors =
  | { password: string; code: string }
  | { password: string; recoveryCode: string }
  | { recoveryCode: string };

interface FactorResult {
  method: "password" | "recovery";
  /** Set when a recovery code was used. */
  recoveryCodesLeft: number | null;
  /** Store this hash (argon2 parameters changed). */
  rehash: string | null;
}

/**
 * Checks password plus code, password plus recovery code, or (accounts without a password) a recovery
 * code alone. Runs the same work for every outcome and uses nothing up; returns a function that does.
 */
async function checkFactors(
  auth: AuthServices,
  account: AccountRow | undefined,
  factors: Factors,
  nowMs: number,
): Promise<((tx: Tx) => FactorResult | null) | null> {
  const hash = account?.passwordHash ?? null;
  const password = "password" in factors ? factors.password : null;
  let passwordOk = false;
  let rehash: string | null = null;
  if (password !== null && hash !== null) {
    const check = await verifyPassword(password, hash);
    passwordOk = check.ok;
    if (check.ok && check.needsRehash) rehash = await hashPassword(password);
  } else {
    // Unknown name, an account without a password, or a recovery code alone: the same hash work.
    await auth.dummyHash.burn(password ?? "recovery");
  }
  if (!account) return null;
  if (password === null) {
    // A recovery code alone is only for accounts that have no password (passkey-only).
    if (hash !== null || !("recoveryCode" in factors)) return null;
  } else if (!passwordOk) {
    return null;
  }

  if ("code" in factors) {
    const secret = totpSecretOf(auth, account);
    const step = secret ? verifyTotp(secret, factors.code, nowMs, account.totpLastStep) : null;
    if (step === null) return null;
    return (tx) =>
      useTotpStep(tx, account.id, step) ? { method: "password", recoveryCodesLeft: null, rehash } : null;
  }
  const code = factors.recoveryCode;
  return (tx) => {
    if (!useRecoveryCode(tx, account.id, code, iso(nowMs))) return null;
    return { method: "recovery", recoveryCodesLeft: recoveryCodesLeft(tx, account.id), rehash };
  };
}

function finishFactors(tx: Tx, accountId: number, result: FactorResult): void {
  if (result.rehash)
    tx.update(accounts).set({ passwordHash: result.rehash }).where(eq(accounts.id, accountId)).run();
}

/** Starts a session for an account that just proved itself (method says how). */
export function startSession(
  db: Db,
  auth: AuthServices,
  nowMs: number,
  account: AccountRow,
  method: SessionMethod,
  client: Client,
  recoveryLeft: number | null = null,
): SessionTokens {
  const { session, refreshToken } = db.transaction((tx) => {
    tx.update(accounts)
      .set({ lastLoginAt: iso(nowMs) })
      .where(eq(accounts.id, account.id))
      .run();
    return createSession(tx, nowMs, {
      accountId: account.id,
      method,
      userAgent: client.userAgent,
      ip: client.ip,
    });
  });
  return sessionTokens(auth.accessKey, nowMs, account, session, refreshToken, recoveryLeft);
}

/** POST /auth/login. */
export async function passwordLogin(
  db: Db,
  auth: AuthServices,
  nowMs: number,
  input: Login,
  client: Client,
): Promise<SessionTokens> {
  const key = nameKey(input.username);
  checkBlocks(db, auth, nowMs, key, client.ip);
  const account = findAccount(db, input.username);
  const use = await checkFactors(auth, account, input, nowMs);
  const result = account && use ? db.transaction((tx) => use(tx)) : null;
  if (!account || !result) {
    countFailure(db, auth, nowMs, key, client.ip);
    throw new ApiError("unauthorized", WRONG_LOGIN);
  }
  db.transaction((tx) => {
    clearFailures(tx, key);
    finishFactors(tx, account.id, result);
  });
  const state = accountStateError(account);
  if (state) throw state;
  return startSession(db, auth, nowMs, account, result.method, client, result.recoveryCodesLeft);
}

/** POST /auth/passkey/login: the passkey names its account (discoverable credential). */
export async function passkeyLogin(
  db: Db,
  auth: AuthServices,
  nowMs: number,
  input: { challengeId: string; response: { id: string; response?: unknown } },
  client: Client,
  log: { warn: (data: object, message: string) => void },
): Promise<SessionTokens> {
  const ipVerdict = auth.limiters.loginFailuresByIp.check(client.ip);
  if (!ipVerdict.ok) throw lockError(ipVerdict.retryAfterSeconds);
  const challenge = auth.challenges.take(input.challengeId, "login");
  const outcome = challenge ? await verifyAssertion(auth, db, challenge.challenge, input.response) : null;
  if (!outcome?.ok) {
    if (outcome?.reason === "counter") {
      log.warn(
        { passkey: input.response.id.slice(0, 16) },
        "passkey sign-in refused: its counter went backwards",
      );
    }
    auth.limiters.loginFailuresByIp.take(client.ip);
    throw new ApiError("unauthorized", PASSKEY_LOGIN_FAILED);
  }
  const account = getAccount(db, outcome.row.accountId);
  if (!account) throw new ApiError("unauthorized", PASSKEY_LOGIN_FAILED);
  markPasskeyUsed(db, outcome.row.id, outcome.newCounter, iso(nowMs));
  const state = accountStateError(account);
  if (state) throw state;
  return startSession(db, auth, nowMs, account, "passkey", client);
}

/** POST /auth/refresh. */
export function refreshSession(
  db: Db,
  auth: AuthServices,
  nowMs: number,
  raw: string,
  ip: string,
): SessionTokens {
  const ipVerdict = auth.limiters.refreshByIp.take(ip);
  if (!ipVerdict.ok) throw tooManyRequests(ipVerdict.retryAfterSeconds);
  const outcome = rotateRefreshToken(db, nowMs, raw, (sessionId) => {
    const verdict = auth.limiters.refreshBySession.take(sessionId);
    if (!verdict.ok) throw tooManyRequests(verdict.retryAfterSeconds);
  });
  if (outcome.kind !== "rotated") throw new ApiError("unauthorized", SESSION_ENDED);
  const account = getAccount(db, outcome.session.accountId);
  if (account?.status !== "active") throw new ApiError("unauthorized", SESSION_ENDED);
  return sessionTokens(auth.accessKey, nowMs, account, outcome.session, outcome.refreshToken);
}

/**
 * POST /auth/reauth: the signed-in person proves it again (password plus code or recovery code, a
 * recovery code alone without a password, or a passkey of this account). Failures count like login
 * failures for the account's name.
 */
export async function reauthenticate(
  db: Db,
  auth: AuthServices,
  nowMs: number,
  session: Pick<SessionRow, "id" | "accountId">,
  input: Reauth,
  client: Client,
): Promise<void> {
  const account = getAccount(db, session.accountId);
  if (!account) throw new ApiError("unauthorized", SESSION_ENDED);
  const key = nameKey(account.username);
  checkBlocks(db, auth, nowMs, key, client.ip);
  const fail = (): never => {
    countFailure(db, auth, nowMs, key, client.ip);
    throw new ApiError("forbidden", WRONG_REAUTH, { reason: "wrong" });
  };

  if ("challengeId" in input) {
    const challenge = auth.challenges.take(input.challengeId, "reauth", {
      accountId: account.id,
      sessionId: session.id,
    });
    const outcome = challenge
      ? await verifyAssertion(auth, db, challenge.challenge, input.response, account.id)
      : null;
    if (!outcome?.ok) return fail();
    db.transaction((tx) => {
      markPasskeyUsed(tx, outcome.row.id, outcome.newCounter, iso(nowMs));
      clearFailures(tx, key);
      markAuthenticated(tx, nowMs, session.id);
    });
    return;
  }
  const use = await checkFactors(auth, account, input, nowMs);
  const done = use
    ? db.transaction((tx) => {
        const result = use(tx);
        if (!result) return false;
        finishFactors(tx, account.id, result);
        clearFailures(tx, key);
        markAuthenticated(tx, nowMs, session.id);
        return true;
      })
    : false;
  if (!done) fail();
}
