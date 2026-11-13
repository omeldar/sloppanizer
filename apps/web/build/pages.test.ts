import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { APP_PATH_PREFIXES, WEB_CACHE_CONTROL, webSecurityHeaders } from "@organizer/shared";
import { describe, expect, it } from "vitest";
import { htmlProblems, STATIC_PAGES } from "./html-guard.ts";

const root = resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

interface VercelRule {
  source: string;
  headers: { key: string; value: string }[];
}
interface VercelConfig {
  installCommand: string;
  buildCommand: string;
  outputDirectory: string;
  framework: string;
  rewrites: { source: string; destination: string }[];
  headers: VercelRule[];
}

const vercel = JSON.parse(read("vercel.json")) as VercelConfig;
const apiUrl = /VITE_API_URL=(\S+)/.exec(vercel.buildCommand)?.[1] ?? "";
const rule = (source: string) => vercel.headers.find((r) => r.source === source);
const pairs = (r: VercelRule | undefined) => (r?.headers ?? []).map(({ key, value }) => [key, value]);

/** Vercel source patterns ("/u/:path*", "/(a|b)") as a regular expression, for the paths we use. */
function sourceMatches(source: string, path: string): boolean {
  const pattern = source.replaceAll(".", "\\.").replace(/\/:path\*/g, "(?:/.*)?");
  return new RegExp(`^${pattern}$`).test(path);
}

describe("vercel.json", () => {
  it("sends exactly the shared security headers on every path, for the API it builds against", () => {
    expect(apiUrl).toBe("https://organizerapi.omeldar.cloud");
    expect(pairs(rule("/(.*)"))).toEqual(webSecurityHeaders({ apiOrigin: apiUrl }));
  });

  it("lets the CSP connect to the API the build uses", () => {
    const csp = rule("/(.*)")?.headers.find((h) => h.key === "Content-Security-Policy")?.value ?? "";
    expect(csp).toContain(`connect-src 'self' ${new URL(apiUrl).origin};`);
  });

  it("caches hashed assets for a year and asks again for everything else", () => {
    expect(pairs(rule("/assets/(.*)"))).toEqual([["Cache-Control", WEB_CACHE_CONTROL.assets]]);
    const html = rule("/((?!assets/).*)");
    expect(pairs(html)).toEqual([["Cache-Control", WEB_CACHE_CONTROL.html]]);
    const htmlSource = new RegExp(`^${html?.source ?? "x"}$`);
    expect(htmlSource.test("/app.html")).toBe(true);
    expect(htmlSource.test("/u/anna/")).toBe(true);
    expect(htmlSource.test("/assets/app-1234.js")).toBe(false);
  });

  const appPaths = [
    ...APP_PATH_PREFIXES.map((p) => (p.endsWith("/") ? `${p}anna/todos/1` : p)),
    "/u",
    "/u/",
    "/u/anna/",
  ];

  it.each(appPaths)("sends %s to app.html and marks it noindex", (path) => {
    const rewrite = vercel.rewrites.find((r) => sourceMatches(r.source, path));
    expect(rewrite?.destination).toBe("/app.html");
    const noindex = vercel.headers.some(
      (r) =>
        sourceMatches(r.source, path) &&
        r.headers.some((h) => h.key === "X-Robots-Tag" && h.value === "noindex"),
    );
    expect(noindex).toBe(true);
  });

  it("rewrites an account's start page with its trailing slash (Vercel's :path* does not match it)", () => {
    expect(vercel.rewrites).toContainEqual({ source: "/u/:account/", destination: "/app.html" });
  });

  it("keeps the landing page out of the rewrites", () => {
    expect(vercel.rewrites.some((r) => sourceMatches(r.source, "/"))).toBe(false);
  });

  it("builds the web package from a frozen lockfile into dist", () => {
    expect(vercel.installCommand).toBe("corepack enable && pnpm install --frozen-lockfile");
    expect(vercel.buildCommand).toMatch(/pnpm --filter @organizer\/web build$/);
    expect(vercel.outputDirectory).toBe("dist");
    expect(vercel.framework).toBe("vite");
  });
});

describe("html pages", () => {
  it.each(["index.html", "app.html", "404.html"])("%s has no inline script", (file) => {
    expect(htmlProblems(read(file), { staticPage: STATIC_PAGES.has(file) })).toEqual([]);
  });

  it("keeps the landing page free of the app bundle", () => {
    const landing = read("index.html");
    expect(landing).not.toContain("/src/main.tsx");
    expect([...landing.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map((m) => m[1])).toEqual(["/landing.js"]);
  });

  it("finds inline scripts, handlers and module scripts on static pages", () => {
    expect(htmlProblems("<script>alert(1)</script>")).toEqual(["inline script (the CSP blocks it)"]);
    expect(htmlProblems('<script type="module">import "x"</script>')).toHaveLength(1);
    expect(htmlProblems('<img src="a.png" onerror="x()">')).toEqual([
      "inline event handler onerror (the CSP blocks it)",
    ]);
    expect(htmlProblems('<a href="javascript:void(0)">x</a>')).toEqual(["javascript: URL"]);
    const app = '<script type="module" crossorigin src="/assets/app.js"></script>';
    expect(htmlProblems(app)).toEqual([]);
    expect(htmlProblems(app, { staticPage: true })).toEqual([
      "module script on a static page (it would load the app bundle)",
    ]);
    expect(htmlProblems('<link rel="modulepreload" href="/assets/x.js">', { staticPage: true })).toHaveLength(
      1,
    );
  });
});
