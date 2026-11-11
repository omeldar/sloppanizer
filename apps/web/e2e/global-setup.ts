import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { E2E_PORT } from "../playwright.config.ts";

const WEB_DIST = resolve(import.meta.dirname, "../dist");
const SERVER_ENTRY = resolve(import.meta.dirname, "../../server/src/index.ts");

/** Starts a throwaway server with an empty data dir, unless E2E_BASE_URL points at a running one. */
export default async function globalSetup(): Promise<(() => Promise<void>) | undefined> {
  if (process.env.E2E_BASE_URL) return undefined;
  if (!existsSync(join(WEB_DIST, "index.html"))) {
    throw new Error(`No web build in ${WEB_DIST}. Run "pnpm build" in the repo root first.`);
  }

  const dataDir = mkdtempSync(join(tmpdir(), "organizer-e2e-"));
  const server = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      ORGANIZER_PORT: String(E2E_PORT),
      ORGANIZER_HOST: "127.0.0.1",
      ORGANIZER_DATA_DIR: dataDir,
      ORGANIZER_WEB_DIR: WEB_DIST,
      LOG_LEVEL: "warn",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  const stop = async () => {
    await stopServer(server);
    rmSync(dataDir, { recursive: true, force: true });
  };

  try {
    await waitForHealth(`http://127.0.0.1:${E2E_PORT}/api/v1/health`, server);
  } catch (error) {
    await stop();
    throw error;
  }
  return stop;
}

async function waitForHealth(url: string, server: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null)
      throw new Error(`The e2e server exited early with code ${server.exitCode}.`);
    try {
      // oxlint-disable-next-line no-await-in-loop -- polling, one request at a time
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    // oxlint-disable-next-line no-await-in-loop -- polling interval
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`The e2e server did not answer on ${url} within 20 s (is port ${E2E_PORT} taken?).`);
}

function stopServer(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null) return Promise.resolve();
  return new Promise((done) => {
    const force = setTimeout(() => server.kill("SIGKILL"), 5000);
    server.once("exit", () => {
      clearTimeout(force);
      done();
    });
    server.kill("SIGTERM");
  });
}
