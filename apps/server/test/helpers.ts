import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { afterEach } from "vitest";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { RestoreLimits } from "../src/services/restore.ts";
import { createToken } from "../src/services/tokens.ts";

export const TEST_INDEX_HTML = "<!doctype html><html><body><div id=root></div></body></html>";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

export interface TestAppOptions {
  /** Start time of the test clock. */
  now?: string;
  timeZone?: string;
  /** Leave out the web build (the placeholder page is served). */
  noWebBuild?: boolean;
  /** Smaller restore limits. */
  limits?: Partial<RestoreLimits>;
}

/** A server on a fresh temp data dir with a movable clock, plus helpers for authenticated calls. */
export async function makeApp(options: TestAppOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "organizer-test-"));
  const dataDir = join(root, "data");
  const webDir = join(root, "web");
  if (!options.noWebBuild) {
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "index.html"), TEST_INDEX_HTML);
    writeFileSync(join(webDir, "assets", "app-abc123.js"), "console.log('app')");
  }
  let current = new Date(options.now ?? "2026-11-11T10:00:00.000Z");
  const config = {
    ...loadConfig({ ORGANIZER_DATA_DIR: dataDir, ORGANIZER_TZ: options.timeZone ?? "Europe/Zurich" }),
    webDir,
  };
  const { app, deps } = await buildApp({
    config,
    clock: () => new Date(current),
    ...(options.limits ? { limits: options.limits } : {}),
  });
  cleanups.push(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const page = await app.inject({ method: "GET", url: "/", headers: { accept: "text/html" } });
  const setCookie = page.headers["set-cookie"];
  const cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0] as string;

  /** A call as the browser session (cookie). */
  const call = (
    method: InjectOptions["method"],
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      headers: { cookie, ...headers },
      ...(body === undefined ? {} : { payload: body as InjectOptions["payload"] }),
    });

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
    dataDir,
    webDir,
    cookie,
    call,
    withToken,
    token: (name: string, scope: "read" | "write", expiresAt?: string) =>
      createToken(deps.db, deps.clock, { name, scope, expiresAt }).raw,
    setNow: (iso: string) => {
      current = new Date(iso);
    },
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
    /** Creates through the API and returns the parsed body; fails loudly on an unexpected status. */
    create: async <T = Record<string, unknown>>(url: string, body: unknown): Promise<T> => {
      const res = await call("POST", url, body);
      if (res.statusCode !== 201) throw new Error(`POST ${url} -> ${res.statusCode}: ${res.body}`);
      return res.json() as T;
    },
  };
}

export type TestApp = Awaited<ReturnType<typeof makeApp>>;

export const json = <T = Record<string, unknown>>(res: LightMyRequestResponse): T => res.json() as T;

export const DAY = 86_400_000;
