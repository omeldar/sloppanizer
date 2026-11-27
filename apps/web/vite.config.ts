import { isAppPath, webSecurityHeaders } from "@organizer/shared";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import type { Connect, Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { addFontPreloads } from "./build/font-preload.ts";
import { htmlProblems, STATIC_PAGES } from "./build/html-guard.ts";

const serverPort = process.env.SLOPPANIZER_PORT ?? "4802";
const serverUrl = `http://127.0.0.1:${serverPort}`;
/** The API's base URL for the build; empty = same origin (the dev proxy, the server's local web mode). */
const apiUrl = (process.env.VITE_API_URL ?? "").replace(/\/+$/, "");

/** The commit this build is made from: Vercel names it, else git, else "unknown" (a copy without .git). */
function buildCommit(): string {
  const fromVercel = process.env.VERCEL_GIT_COMMIT_SHA;
  if (fromVercel) return fromVercel;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

/** Dev and preview: the app's paths load app.html, like the Vercel rewrites and the server do. */
const appRewrite: Connect.NextHandleFunction = (req, _res, next) => {
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  if (req.method === "GET" && isAppPath(path) && req.headers.accept?.includes("text/html")) {
    req.url = "/app.html";
  }
  next();
};

function appRoutes(): Plugin {
  return {
    name: "sloppanizer-app-routes",
    configureServer: (server) => void server.middlewares.use(appRewrite),
    configurePreviewServer: (server) => void server.middlewares.use(appRewrite),
  };
}

/** Fails the build when a page has an inline script or a static page loads the app bundle. */
function htmlGuard(): Plugin {
  return {
    name: "sloppanizer-html-guard",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== "asset" || !file.fileName.endsWith(".html")) continue;
        const problems = htmlProblems(String(file.source), { staticPage: STATIC_PAGES.has(file.fileName) });
        if (problems.length > 0) this.error(`${file.fileName}: ${problems.join(", ")}`);
      }
    },
  };
}

/** Build: the landing page preloads its two fonts (hashed names, known only once the bundle exists). */
function landingFontPreload(): Plugin {
  return {
    name: "sloppanizer-landing-fonts",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler: (html, ctx) =>
        ctx.filename.endsWith("/index.html") && ctx.bundle
          ? addFontPreloads(html, Object.keys(ctx.bundle))
          : html,
    },
  };
}

export default defineConfig({
  plugins: [react(), appRoutes(), landingFontPreload(), htmlGuard()],
  // The version comes from package.json (the same as the server's, `pnpm release` sets both).
  define: { __APP_COMMIT__: JSON.stringify(buildCommit()) },
  // Several pages; unknown paths are a 404, not the app.
  appType: "mpa",
  build: {
    // The editor chunk is large; it loads only with the first todo or note opened. Mermaid's ELK layout
    // (~1.5 MB) loads only for a diagram with `layout: elk`; the limit sits just above it.
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      input: { index: "index.html", app: "app.html", notFound: "404.html" },
    },
  },
  server: {
    port: 5181,
    strictPort: true,
    proxy: {
      "/api": serverUrl,
    },
  },
  // `vite preview` (the e2e run) sends the same headers as the hosted site, so CSP problems show there.
  preview: {
    headers: Object.fromEntries(webSecurityHeaders({ apiOrigin: apiUrl || null })),
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "build/**/*.test.ts"],
    setupFiles: ["./src/test/setup.ts"],
    // `pnpm test` runs every package at once: each takes its share of the cores, not all of them.
    maxWorkers: "50%",
    // Most tests render the whole app with its router and queries, several times over. On a busy
    // machine one such test takes a few seconds, so the 5 s default only measured the machine's load.
    testTimeout: 15_000,
    css: { modules: { classNameStrategy: "non-scoped" } },
  },
});
