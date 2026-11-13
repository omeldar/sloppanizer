import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const serverPort = process.env.ORGANIZER_PORT ?? "4802";
const serverUrl = `http://127.0.0.1:${serverPort}`;

/**
 * Dev only: the server hands out the session cookie with its HTML, but in dev Vite serves the HTML.
 * On a page load without a session, fetch the server's page once and pass its Set-Cookie on.
 * Cookies are per host, not per port, so the cookie then also goes through the /api proxy.
 */
function devSession(): Plugin {
  return {
    name: "organizer-dev-session",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const wantsHtml =
          req.method === "GET" && !req.url?.startsWith("/api") && req.headers.accept?.includes("text/html");
        if (!wantsHtml || req.headers.cookie?.includes("org_session=")) return next();
        fetch(`${serverUrl}/`, { headers: { host: req.headers.host ?? "localhost" } })
          .then((response) => res.setHeader("set-cookie", response.headers.getSetCookie()))
          .catch(() =>
            server.config.logger.warn(
              `organizer server not reachable at ${serverUrl}; start it to get a session.`,
            ),
          )
          .finally(() => next());
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devSession()],
  build: {
    // A local, offline app: the editor chunk is large but loads from disk.
    chunkSizeWarningLimit: 800,
  },
  server: {
    port: 5181,
    strictPort: true,
    proxy: {
      "/api": serverUrl,
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
    // `pnpm test` runs every package at once: each takes its share of the cores, not all of them.
    maxWorkers: "50%",
    // Most tests render the whole app with its router and queries, several times over. On a busy
    // machine one such test takes a few seconds, so the 5 s default only measured the machine's load.
    testTimeout: 15_000,
    css: { modules: { classNameStrategy: "non-scoped" } },
  },
});
