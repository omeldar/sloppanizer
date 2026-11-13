import type { AccountRole, AccountStatus } from "@organizer/shared";
import { eq } from "drizzle-orm";
import type { InjectOptions } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { LOG_REDACT } from "../src/http/security.ts";
import type { Clock } from "../src/clock.ts";
import { sessions } from "../src/db/auth-schema.ts";
import type { Db } from "../src/db/index.ts";
import {
  type AccountRow,
  getAccount,
  insertAccount,
  replaceRecoveryCodes,
} from "../src/services/accounts.ts";
import { ACCESS_TOKEN_TTL_MS, mintAccessToken } from "../src/services/auth/access-token.ts";
import type { AuthServices } from "../src/services/auth/index.ts";
import { hashPassword } from "../src/services/auth/password.ts";
import { createSession, isLive, type SessionRow } from "../src/services/auth/sessions.ts";
import { totpCode, totpStep } from "../src/services/auth/totp.ts";
import { seedAccount } from "../src/services/owned.ts";

/**
 * Accounts and signed-in sessions for server tests, made directly through the services (no HTTP login,
 * so tests of other features do not depend on the sign-in flows).
 */

/** What createTestAccount needs: buildApp's deps (db, clock) and auth services. */
export interface AuthTestEnv {
  deps: { db: Db; clock: Clock };
  auth: AuthServices;
}

export const TEST_PASSWORD = "violet tram drifts over 9 hills";
/** 32 base32 characters (160 bits). Tests that need two secrets pass their own. */
export const TEST_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

const hashes = new Map<string, Promise<string>>();
/** argon2id costs ~20 MB and tens of ms: each test password is hashed once per test file. */
const cachedHash = (password: string): Promise<string> => {
  let hash = hashes.get(password);
  if (!hash) {
    hash = hashPassword(password);
    hashes.set(password, hash);
  }
  return hash;
};

export interface TestAccountOptions {
  username: string;
  displayName?: string;
  role?: AccountRole;
  /** Default active (seeded with the priority labels like an approved account). */
  status?: AccountStatus;
  /** Default TEST_PASSWORD; null makes a passkey-only account (no password, no authenticator). */
  password?: string | null;
  /** Default TEST_TOTP_SECRET (ignored without a password). */
  totpSecret?: string;
  timeZone?: string;
  /** Start a session (default true for active accounts). */
  signedIn?: boolean;
}

export interface TestAccount {
  id: number;
  username: string;
  password: string | null;
  totpSecret: string | null;
  /** The 10 recovery codes made with the account. */
  recoveryCodes: string[];
  /** The account row as it is now. */
  row(): AccountRow;
  /** The current session (null when the account was made signed out). */
  session(): SessionRow | null;
  /** The refresh token of the current session. */
  refreshToken(): string;
  /**
   * `{ authorization: "Bearer spa_..." }` valid at the test clock's now. When the session ran out by
   * time (the clock moved past 30 idle or 90 days), a new one is started; a revoked session stays revoked.
   */
  headers(): Record<string, string>;
  /** Marks the session freshly signed in (the reauth window of sensitive actions starts now). */
  reauthenticate(): void;
  /** The authenticator code at the test clock's now (each step works once: move the clock 30 s between uses). */
  code(): string;
}

/** Makes an account (active and signed in by default) through the services. */
export async function createTestAccount(env: AuthTestEnv, options: TestAccountOptions): Promise<TestAccount> {
  const { db, clock } = env.deps;
  const status = options.status ?? "active";
  const password = options.password === undefined ? TEST_PASSWORD : options.password;
  const totpSecret = password === null ? null : (options.totpSecret ?? TEST_TOTP_SECRET);
  const passwordHash = password === null ? null : await cachedHash(password);
  const nowIso = clock().toISOString();
  const { row, recoveryCodes } = db.transaction((tx) => {
    const created = insertAccount(tx, env.auth.dataKey, nowIso, {
      username: options.username,
      displayName: options.displayName ?? options.username,
      timeZone: options.timeZone ?? "Europe/Zurich",
      status,
      ...(options.role ? { role: options.role } : {}),
      passwordHash,
      totpSecret,
      // A step in the past, so the code of "now" still works once.
      totpStep: totpSecret ? totpStep(clock().getTime()) - 2 : null,
    });
    if (status === "active") seedAccount(tx, created.id, nowIso);
    return { row: created, recoveryCodes: replaceRecoveryCodes(tx, created.id, nowIso) };
  });

  let current: { session: SessionRow; refreshToken: string } | null = null;
  const start = () => {
    current = createSession(db, clock().getTime(), {
      accountId: row.id,
      method: password === null ? "passkey" : "password",
      userAgent: "test",
      ip: "127.0.0.1",
    });
    return current;
  };
  if (options.signedIn ?? status === "active") start();

  const load = (): SessionRow | null =>
    current ? (db.select().from(sessions).where(eq(sessions.id, current.session.id)).get() ?? null) : null;

  return {
    id: row.id,
    username: row.username,
    password,
    totpSecret,
    recoveryCodes,
    row: () => {
      const now = getAccount(db, row.id);
      if (!now) throw new Error(`${row.username} was deleted`);
      return now;
    },
    session: load,
    refreshToken: () => {
      if (!current) throw new Error(`${row.username} has no session`);
      return current.refreshToken;
    },
    headers: () => {
      const nowMs = clock().getTime();
      let live = load();
      if (!live || (live.revokedAt === null && !isLive(live, nowMs))) live = start().session;
      const token = mintAccessToken(env.auth.accessKey, {
        sid: live.id,
        aid: row.id,
        exp: nowMs + ACCESS_TOKEN_TTL_MS,
      });
      return { authorization: `Bearer ${token}` };
    },
    reauthenticate: () => {
      const live = load() ?? start().session;
      db.update(sessions)
        .set({ authenticatedAt: clock().toISOString() })
        .where(eq(sessions.id, live.id))
        .run();
    },
    code: () => {
      if (!totpSecret) throw new Error(`${row.username} has no authenticator`);
      return totpCode(totpSecret, clock().getTime());
    },
  };
}

/** The authenticator code of a secret at a moment. */
export const codeAt = (secret: string, clock: Clock): string => totpCode(secret, clock().getTime());

// ---------------------------------------------------------------------------------------------------------
// An app for the auth tests: real config from an env, movable clock, captured logs.

export const WEB_ORIGIN = "https://app.example.test";
export const SETUP_CODE = "TEST-SETU-PCOD-EFOR-TEST";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

export interface AuthAppOptions {
  /** Extra or replaced SLOPPANIZER_* values. */
  env?: Record<string, string>;
  now?: string;
  /** An existing data dir (restart tests). */
  dataDir?: string;
}

/** A server for auth tests: web origin https://app.example.test (RP ID app.example.test), fixed setup code. */
export async function makeAuthApp(options: AuthAppOptions = {}) {
  const root = options.dataDir ? null : mkdtempSync(join(tmpdir(), "sloppanizer-auth-"));
  const dataDir = options.dataDir ?? join(root as string, "data");
  const config = loadConfig({
    SLOPPANIZER_DATA_DIR: dataDir,
    SLOPPANIZER_WEB_ORIGINS: WEB_ORIGIN,
    SLOPPANIZER_RP_ID: "app.example.test",
    SLOPPANIZER_SETUP_CODE: SETUP_CODE,
    SLOPPANIZER_DEFAULT_TZ: "Europe/Zurich",
    ...options.env,
  });
  let current = new Date(options.now ?? "2026-11-11T10:00:00.000Z");
  const clock = () => new Date(current);
  const logs: string[] = [];
  const { app, deps, auth } = await buildApp({
    config,
    clock,
    logger: {
      level: "info",
      redact: { paths: LOG_REDACT, censor: "[redacted]" },
      stream: { write: (line: string) => logs.push(line) },
    },
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.close();
  };
  cleanups.push(async () => {
    await close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** A call; `headers` adds to (or replaces) the defaults. Bodies are sent as JSON. */
  const call = (
    method: InjectOptions["method"],
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36", ...headers },
      ...(body === undefined ? {} : { payload: body as InjectOptions["payload"] }),
    });

  const env = { deps, auth };
  return {
    app,
    deps,
    auth,
    config,
    dataDir,
    logs,
    call,
    /** Closes the app now (restart tests); the data dir stays until the test ends. */
    close,
    clock,
    setNow: (iso: string) => {
      current = new Date(iso);
    },
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
    account: (accountOptions: TestAccountOptions) => createTestAccount(env, accountOptions),
  };
}

export type AuthApp = Awaited<ReturnType<typeof makeAuthApp>>;
