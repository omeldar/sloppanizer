import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    passWithNoTests: true,
    // `pnpm test` runs every package at once: each takes its share of the cores, not all of them.
    maxWorkers: "25%",
    // The integration test starts the real server and bundles the MCP server.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
