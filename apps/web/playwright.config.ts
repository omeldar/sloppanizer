import { defineConfig } from "@playwright/test";

// End to end tests of the built app, served by the real server.
// By default e2e/global-setup.ts starts a throwaway server on its own port and data dir.
// E2E_BASE_URL runs the same tests against a running instance instead (they clean up after themselves).
export const E2E_PORT = 4804;

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  // One flow that builds on itself; parallel workers would only fight over the same data.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${E2E_PORT}`,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    trace: "retain-on-failure",
  },
});
