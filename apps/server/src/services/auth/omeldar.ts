import {
  type OidcCallback,
  type OidcReauth,
  RESERVED_USERNAMES,
  type SessionTokens,
  Username,
} from "@organizer/shared";
import { and, eq } from "drizzle-orm";
import type { Config } from "../../config.ts";
import { accounts, sessions } from "../../db/auth-schema.ts";
import type { Db } from "../../db/index.ts";
import { ApiError } from "../../http/errors.ts";
import { tooManyRequests } from "../../http/rate-limit.ts";
import { type AccountRow, getAccount, insertAccount } from "../accounts.ts";
import type { Tx } from "../context.ts";
import { seedAccount } from "../owned.ts";
import type { AuthServices } from "./index.ts";
import { logAdminEvent } from "./instance.ts";
import { type Client, startSession } from "./login.ts";
import { AuthError, type AuthClient, createAuthClient, type User } from "./omeldar-auth.ts";
import { markAuthenticated, revokeAccountSessions, revokeSession } from "./sessions.ts";

/**
 * "Sign in with omeldar" (auth.omeldar.com, OpenID Connect), switched by SLOPPANIZER_AUTH. The web app
 * starts the sign-in and receives the callback; it hands the query and its pending sign-in to the server,
 * which exchanges the code here (with the client secret) and starts Sloppanizer's own session exactly like
 * a local login. Accounts keep their id, so data, API tokens, MCP grants and calendar feeds stay.
 *
 * Who is who: `accounts.auth_subject` = the person's `sub`. A person's first sign-in binds the account
 * auth imported for them (`legacy_id` = accounts.id), else makes a new account. Never by username or email.
 */

/** The parts of the omeldar client the server uses (tests pass a fake). */
export type OmeldarClient = Pick<AuthClient, "callback" | "verifyLogoutToken">;

/** The client for the config, or null with SLOPPANIZER_AUTH=local. */
export function createOmeldarClient(config: Config["omeldar"]): OmeldarClient | null {
  if (config.mode === "local") return null;
  return createAuthClient({
    issuer: config.issuer,
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    ...(config.clientSecret ? { clientSecret: config.clientSecret } : {}),
  });
}

const OFF = "Sign-in with omeldar is not turned on here.";

/** Whether Sloppanizer's own login has ended (SLOPPANIZER_LOCAL_LOGIN_UNTIL passed, with "both"). */
export function localLoginEnded(config: Config["omeldar"], nowMs: number): boolean {
  return config.localLoginEnds !== null && nowMs >= config.localLoginEnds.at.getTime();
}

/** What the own login, sign-up, setup and reset answer once it has ended. */
export function localLoginEndedMessage(config: Config["omeldar"]): string {
  const day = config.localLoginEnds?.on ?? "";
  return `Sign-in with your Sloppanizer password ended on ${day}. Use "Sign in with omeldar" (auth.omeldar.com). If you never moved your sign-in, try your Sloppanizer username and password there, or ask the admin.`;
}
/** A sensitive action accepts a sign-in at auth this recent. */
const REAUTH_MAX_AGE_S = 300;

function clientOf(auth: AuthServices): OmeldarClient {
  if (!auth.omeldar) throw new ApiError("not_found", OFF);
  return auth.omeldar;
}

/** Exchanges the code; auth's errors become a 401 with its reason (cancelled, tampered, expired). */
async function exchange(client: OmeldarClient, input: { query: string; pending: OidcCallback["pending"] }) {
  try {
    return (await client.callback(new URLSearchParams(input.query), input.pending)).user;
  } catch (error) {
    if (error instanceof AuthError) {
      const cancelled = error.code === "access_denied";
      throw new ApiError(
        "unauthorized",
        cancelled ? "Sign-in was cancelled." : `Sign-in at omeldar did not work: ${error.message}`,
        { reason: error.code },
      );
    }
    throw error;
  }
}

/** A free username like the person's at auth (it is in Sloppanizer's addresses, so it must be valid here). */
function freeUsername(tx: Tx, wanted: string): string {
  const cleaned = wanted
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/^[._-]+/, "")
    .slice(0, 28);
  const base = Username.safeParse(cleaned).success ? cleaned : `user-${cleaned}`.slice(0, 28);
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? base : `${base.slice(0, 28)}-${n}`;
    if (!Username.safeParse(name).success || (RESERVED_USERNAMES as readonly string[]).includes(name))
      continue;
    if (!tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.username, name)).get()) return name;
  }
  throw new ApiError("conflict", "No free username was found. Ask the admin.");
}

/** What a sign-in at auth changes on the account: its name (when auth has one) and its role. */
function follow(tx: Tx, account: AccountRow, user: User, nowIso: string): AccountRow {
  tx.update(accounts)
    .set({
      ...(user.name?.trim() ? { displayName: user.name.trim().slice(0, 60) } : {}),
      role: user.app_role === "admin" ? "admin" : "user",
      updatedAt: nowIso,
    })
    .where(eq(accounts.id, account.id))
    .run();
  return getAccount(tx, account.id) as AccountRow;
}

/**
 * The account of a person signed in at auth: by `sub`; else the old account auth imported (`legacy_id`)
 * when it is not bound yet; else a new, active account (auth already approved them).
 */
export function findOrLinkAccount(
  tx: Tx,
  dataKey: Buffer,
  nowIso: string,
  user: User,
  timeZone: string,
): AccountRow {
  const bound = tx.select().from(accounts).where(eq(accounts.authSubject, user.sub)).get();
  if (bound) return follow(tx, bound, user, nowIso);

  const legacyId =
    typeof user.legacy_id === "string" && /^\d{1,10}$/.test(user.legacy_id) ? Number(user.legacy_id) : null;
  if (legacyId !== null) {
    const old = getAccount(tx, legacyId);
    if (old && old.kind === "user" && old.authSubject === null) {
      tx.update(accounts).set({ authSubject: user.sub }).where(eq(accounts.id, old.id)).run();
      return follow(tx, getAccount(tx, old.id) as AccountRow, user, nowIso);
    }
  }

  const username = freeUsername(tx, user.preferred_username);
  const row = insertAccount(tx, dataKey, nowIso, {
    username,
    displayName: (user.name?.trim() || user.preferred_username).slice(0, 60),
    timeZone,
    status: "active",
    role: user.app_role === "admin" ? "admin" : "user",
    passwordHash: null,
    totpSecret: null,
    totpStep: null,
  });
  tx.update(accounts).set({ authSubject: user.sub }).where(eq(accounts.id, row.id)).run();
  seedAccount(tx, row.id, nowIso);
  return getAccount(tx, row.id) as AccountRow;
}

/** POST /auth/omeldar/callback: finishes "Sign in with omeldar" and starts a Sloppanizer session. */
export async function omeldarSignIn(
  db: Db,
  auth: AuthServices,
  nowMs: number,
  input: OidcCallback,
  client: Client,
  fallbackTimeZone: string,
): Promise<SessionTokens> {
  const omeldar = clientOf(auth);
  const verdict = auth.limiters.passkeyOptionsByIp.take(client.ip);
  if (!verdict.ok) throw tooManyRequests(verdict.retryAfterSeconds);
  const user = await exchange(omeldar, input);
  const nowIso = new Date(nowMs).toISOString();
  const account = db.transaction((tx) => {
    const found = findOrLinkAccount(tx, auth.dataKey, nowIso, user, input.timeZone ?? fallbackTimeZone);
    // Auth approved them for Sloppanizer; an account disabled here stays disabled.
    if (found.status === "pending") {
      tx.update(accounts)
        .set({ status: "active", approvedAt: nowIso, updatedAt: nowIso })
        .where(eq(accounts.id, found.id))
        .run();
      seedAccount(tx, found.id, nowIso);
      return getAccount(tx, found.id) as AccountRow;
    }
    return found;
  });
  if (account.status !== "active") {
    throw new ApiError("forbidden", "This account is disabled in Sloppanizer. Ask the admin.", {
      reason: "disabled",
    });
  }
  return startSession(db, auth, nowMs, account, "oidc", client, null, {
    authSid: user.sid,
    authenticatedAtMs: user.auth_time * 1000,
  });
}

/** POST /auth/omeldar/reauth: a fresh sign-in at auth (max_age 0) as the session's own person. */
export async function omeldarReauth(
  db: Db,
  auth: AuthServices,
  nowMs: number,
  session: { id: string; accountId: number },
  input: OidcReauth,
): Promise<void> {
  const user = await exchange(clientOf(auth), input);
  const account = getAccount(db, session.accountId);
  if (!account || account.authSubject !== user.sub) {
    throw new ApiError("forbidden", "That was another person's sign-in. Sign in as yourself.", {
      reason: "wrong",
    });
  }
  if (nowMs / 1000 - user.auth_time > REAUTH_MAX_AGE_S) {
    throw new ApiError("forbidden", "Sign in again at omeldar to confirm it is you.", { reason: "stale" });
  }
  db.transaction((tx) => markAuthenticated(tx, nowMs, session.id));
}

/** Whether the session's account may move its sign-in to omeldar now (POST /auth/omeldar/link/start). */
export function omeldarLinkReady(db: Db, auth: AuthServices, accountId: number): void {
  clientOf(auth);
  const account = getAccount(db, accountId);
  if (!account) throw new ApiError("unauthorized", "Sign in again.");
  if (account.authSubject !== null) {
    throw new ApiError("conflict", "Your sign-in already moved to omeldar.", { reason: "linked" });
  }
}

/**
 * POST /auth/omeldar/link: moves the signed-in account's sign-in to the omeldar account that just signed
 * in (a fresh sign-in there, in a popup). Binds `auth_subject` only: never an omeldar account that belongs
 * to another Sloppanizer account (bound already, or imported from one). Name and role follow at the next
 * sign-in with omeldar, as for everyone. The own credentials stay until the own login is removed.
 */
export async function omeldarLink(
  db: Db,
  auth: AuthServices,
  nowMs: number,
  session: { accountId: number },
  input: OidcReauth,
): Promise<void> {
  const user = await exchange(clientOf(auth), input);
  if (nowMs / 1000 - user.auth_time > REAUTH_MAX_AGE_S) {
    throw new ApiError("forbidden", "Sign in again at omeldar to move your sign-in.", { reason: "stale" });
  }
  const legacyId =
    typeof user.legacy_id === "string" && /^\d{1,10}$/.test(user.legacy_id) ? Number(user.legacy_id) : null;
  const nowIso = new Date(nowMs).toISOString();
  db.transaction((tx) => {
    const account = getAccount(tx, session.accountId);
    if (!account) throw new ApiError("unauthorized", "Sign in again.");
    if (account.authSubject === user.sub) return;
    if (account.authSubject !== null) {
      throw new ApiError("conflict", "Your sign-in already moved to another omeldar account.", {
        reason: "linked",
      });
    }
    const taken = tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.authSubject, user.sub))
      .get();
    if (taken || (legacyId !== null && legacyId !== account.id)) {
      throw new ApiError(
        "conflict",
        "That omeldar account belongs to another Sloppanizer account. Sign in at omeldar as yourself, or ask the admin.",
        { reason: "other_account" },
      );
    }
    tx.update(accounts)
      .set({ authSubject: user.sub, updatedAt: nowIso })
      .where(eq(accounts.id, account.id))
      .run();
    logAdminEvent(tx, nowIso, account.username, "move_signin", account.username, {
      omeldarUsername: user.preferred_username,
    });
  });
}

/**
 * POST /auth/backchannel-logout from auth (sign-out there, disabled, password reset): ends the session of
 * that sign-in, or every session of the person when the token names no session.
 */
export async function omeldarBackchannelLogout(
  db: Db,
  auth: AuthServices,
  nowMs: number,
  logoutToken: string,
): Promise<number> {
  let claims: { sub: string; sid?: string };
  try {
    claims = await clientOf(auth).verifyLogoutToken(logoutToken);
  } catch (error) {
    if (error instanceof AuthError)
      throw new ApiError("validation_failed", "That is not a valid logout token.");
    throw error;
  }
  const account = db.select().from(accounts).where(eq(accounts.authSubject, claims.sub)).get();
  if (!account) return 0;
  return db.transaction((tx) => {
    if (!claims.sid) return revokeAccountSessions(tx, nowMs, account.id, "other_logout");
    const own = tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.accountId, account.id), eq(sessions.authSid, claims.sid)))
      .all();
    return own.filter((row) => revokeSession(tx, nowMs, account.id, row.id, "other_logout")).length;
  });
}
