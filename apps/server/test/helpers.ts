import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { afterEach } from "vitest";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { accountFilesDir } from "../src/services/attachments.ts";
import type { Ctx } from "../src/services/context.ts";
import type { RestoreLimits } from "../src/services/restore.ts";
import { createToken } from "../src/services/tokens.ts";
import { createTestAccount, type TestAccount, type TestAccountOptions } from "./auth-helpers.ts";

export const TEST_INDEX_HTML = "<!doctype html><html><body><div id=root></div></body></html>";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

export interface TestAppOptions {
  /** Start time of the test clock. */
  now?: string;
  /** Time zone of the default account "anna" (default Europe/Zurich). */
  timeZone?: string;
  /** Leave out the web build (the placeholder page is served). */
  noWebBuild?: boolean;
  /** Smaller restore limits. */
  limits?: Partial<RestoreLimits>;
  /** Further SLOPPANIZER_* settings. */
  env?: Record<string, string>;
}

type Call = (
  method: InjectOptions["method"],
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<LightMyRequestResponse>;

/**
 * A server on a fresh temp data dir with a movable clock and a signed-in default account "anna", plus
 * helpers for authenticated calls. `asAccount` adds further accounts (cross-account tests).
 */
export async function makeApp(options: TestAppOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "sloppanizer-test-"));
  const dataDir = join(root, "data");
  const webDir = join(root, "web");
  if (!options.noWebBuild) {
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "index.html"), TEST_INDEX_HTML);
    writeFileSync(join(webDir, "app.html"), TEST_INDEX_HTML);
    writeFileSync(join(webDir, "assets", "app-abc123.js"), "console.log('app')");
  }
  let current = new Date(options.now ?? "2026-11-11T10:00:00.000Z");
  const config = {
    ...loadConfig({
      SLOPPANIZER_DATA_DIR: dataDir,
      SLOPPANIZER_SETUP_CODE: "TESTSETUPCODE0000000000000",
      ...options.env,
    }),
    webDir,
  };
  const { app, deps, auth } = await buildApp({
    config,
    clock: () => new Date(current),
    ...(options.limits ? { limits: options.limits } : {}),
  });
  cleanups.push(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * Calls as the account's browser session. The session counts as freshly signed in, so sensitive
   * routes (token create, restore apply) work; the reauth rules have their own tests.
   */
  const callAs =
    (account: TestAccount): Call =>
    (method, url, body, headers = {}) => {
      account.reauthenticate();
      return app.inject({
        method,
        url,
        headers: { ...account.headers(), ...headers },
        ...(body === undefined ? {} : { payload: body as InjectOptions["payload"] }),
      });
    };
  const creatorOf =
    (call: Call) =>
    async <T = Record<string, unknown>>(url: string, body: unknown): Promise<T> => {
      const res = await call("POST", url, body);
      if (res.statusCode !== 201) throw new Error(`POST ${url} -> ${res.statusCode}: ${res.body}`);
      return res.json() as T;
    };
  /** Everything a test needs to act as one account: calls, tokens, the service context and files folder. */
  const actor = (account: TestAccount) => {
    const call = callAs(account);
    return {
      account,
      call,
      create: creatorOf(call),
      token: (name: string, scope: "read" | "write", expiresAt?: string) =>
        createToken(deps.db, deps.clock, account.id, { name, scope, expiresAt }).raw,
      ctx: (): Ctx => ({
        db: deps.db,
        clock: deps.clock,
        timeZone: account.row().timeZone,
        accountId: account.id,
      }),
      filesDir: accountFilesDir(deps.filesDir, account.id),
    };
  };
  const anna = actor(
    await createTestAccount(
      { deps, auth },
      { username: "anna", timeZone: options.timeZone ?? "Europe/Zurich" },
    ),
  );
  const { call } = anna;

  /** A call with a bearer token. */
  const withToken = (raw: string, method: InjectOptions["method"], url: string, body?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${raw}` },
      ...(body === undefined ? {} : { payload: body as InjectOptions["payload"] }),
    });

  return {
    app,
    deps,
    auth,
    /** The config the server runs with (a second buildApp with it is a restart on the same data). */
    config,
    dataDir,
    webDir,
    /** The default account. */
    account: anna.account,
    /** Service context of the default account. */
    ctx: anna.ctx,
    /** Files folder of the default account. */
    filesDir: anna.filesDir,
    /** A call as the default account's browser session. */
    call,
    withToken,
    /** A raw API token of the default account. */
    token: anna.token,
    /** Creates through the API and returns the parsed body; fails loudly on an unexpected status. */
    create: anna.create,
    /** Another signed-in account with the same helpers (the default one stays "anna"). */
    asAccount: async (accountOptions: TestAccountOptions) =>
      actor(await createTestAccount({ deps, auth }, accountOptions)),
    setNow: (iso: string) => {
      current = new Date(iso);
    },
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

export type TestActor = Awaited<ReturnType<TestApp["asAccount"]>>;

export type TestApp = Awaited<ReturnType<typeof makeApp>>;

export const json = <T = Record<string, unknown>>(res: LightMyRequestResponse): T => res.json() as T;

export const DAY = 86_400_000;
