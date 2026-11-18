import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers.ts";

type Access = "read" | "write" | "session";

/**
 * Every API route with the access it must have: "read" = any token may call it (GET only),
 * "write" = needs a write token or the session, "session" = the browser session only.
 */
const MATRIX: [method: string, path: string, access: Access][] = [
  ["GET", "/me", "read"],
  ["GET", "/projects", "read"],
  ["POST", "/projects", "write"],
  ["GET", "/projects/1", "read"],
  ["PATCH", "/projects/1", "write"],
  ["DELETE", "/projects/1", "write"],
  ["GET", "/people", "read"],
  ["POST", "/people", "write"],
  ["GET", "/people/1", "read"],
  ["PATCH", "/people/1", "write"],
  ["DELETE", "/people/1", "write"],
  ["GET", "/person-tags", "read"],
  ["POST", "/person-tags", "write"],
  ["PATCH", "/person-tags/1", "write"],
  ["DELETE", "/person-tags/1", "write"],
  ["GET", "/labels", "read"],
  ["POST", "/labels", "write"],
  ["PATCH", "/labels/1", "write"],
  ["DELETE", "/labels/1", "write"],
  ["GET", "/stats", "read"],
  ["GET", "/stats/people", "read"],
  ["GET", "/stats/people/1", "read"],
  ["GET", "/search?q=abc", "read"],
  ["GET", "/settings", "session"],
  ["GET", "/topics", "read"],
  ["PATCH", "/topics/1", "write"],
  ["DELETE", "/topics/1", "write"],
  ["GET", "/teams", "read"],
  ["GET", "/next", "read"],
  ["GET", "/todos", "read"],
  ["POST", "/todos", "write"],
  ["POST", "/todos/bulk", "write"],
  ["GET", "/todos/1", "read"],
  ["PATCH", "/todos/1", "write"],
  ["DELETE", "/todos/1", "write"],
  ["POST", "/todos/1/subtasks", "write"],
  ["POST", "/todos/1/links", "write"],
  ["DELETE", "/todos/1/links/2", "write"],
  ["POST", "/todos/1/checklist", "write"],
  ["POST", "/todos/1/urls", "write"],
  ["PATCH", "/todos/1/urls/2", "write"],
  ["DELETE", "/todos/1/urls/2", "write"],
  ["GET", "/blocks?from=2026-11-01&to=2026-11-02", "read"],
  ["POST", "/blocks", "write"],
  ["GET", "/ai/settings", "session"],
  ["PATCH", "/ai/settings", "session"],
  ["POST", "/ai/plan", "write"],
  ["POST", "/ai/breakdown", "write"],
  ["POST", "/ai/standup", "write"],
  ["GET", "/calendar-feed", "session"],
  ["POST", "/calendar-feed", "session"],
  ["DELETE", "/calendar-feed", "session"],
  ["PATCH", "/blocks/1", "write"],
  ["DELETE", "/blocks/1", "write"],
  ["GET", "/todos/1/comments", "read"],
  ["POST", "/todos/1/comments", "write"],
  ["GET", "/todos/1/activity", "read"],
  ["PATCH", "/comments/1", "write"],
  ["DELETE", "/comments/1", "write"],
  ["GET", "/meetings", "read"],
  ["POST", "/meetings", "write"],
  ["GET", "/meetings/occurrences?from=2026-11-01&to=2026-11-02", "read"],
  ["GET", "/meetings/1", "read"],
  ["PATCH", "/meetings/1", "write"],
  ["DELETE", "/meetings/1", "write"],
  ["PATCH", "/meetings/1/schedule", "write"],
  ["PATCH", "/meetings/1/occurrences/2026-11-19", "write"],
  ["GET", "/meetings/1/standup", "read"],
  ["POST", "/meetings/1/standup/marks", "write"],
  ["DELETE", "/meetings/1/standup/marks/2026-11-19/2", "write"],
  ["GET", "/meetings/1/notes", "read"],
  ["POST", "/meetings/1/notes", "write"],
  ["DELETE", "/meetings/1/notes/2026-11-19", "write"],
  ["GET", "/meetings/1/todos", "read"],
  ["POST", "/meetings/1/todos", "write"],
  ["DELETE", "/meetings/1/todos/2", "write"],
  ["POST", "/meetings/1/todos/2/due", "write"],
  ["GET", "/todos/1/meetings", "read"],
  ["GET", "/todos/recurring", "read"],
  ["GET", "/stats/overview?from=2026-11-01&to=2026-11-30", "read"],
  ["GET", "/blocks/series?from=2026-11-01&to=2026-11-02", "read"],
  ["GET", "/todos/1/plan", "read"],
  ["POST", "/todos/1/plan", "write"],
  ["PATCH", "/todos/1/plan/2026-11-19", "write"],
  ["DELETE", "/todos/1/plan", "write"],
  ["GET", "/notes", "read"],
  ["POST", "/notes", "write"],
  ["GET", "/notes/1", "read"],
  ["PATCH", "/notes/1", "write"],
  ["DELETE", "/notes/1", "write"],
  ["POST", "/attachments?name=a.txt", "write"],
  ["GET", "/attachments/1", "read"],
  ["GET", "/attachments/1/meta", "read"],
  ["GET", "/attachments/1/a.png", "read"],
  ["GET", "/export.zip", "write"],
  ["GET", "/tokens", "session"],
  ["POST", "/tokens", "session"],
  ["DELETE", "/tokens/1", "session"],
  ["POST", "/restore?name=a.zip", "session"],
  ["GET", "/restore/backups", "session"],
  ["GET", "/restore/backups/x.zip", "session"],
  ["GET", `/restore/${"a".repeat(32)}`, "session"],
  ["DELETE", `/restore/${"a".repeat(32)}`, "session"],
  ["POST", `/restore/${"a".repeat(32)}/apply`, "session"],
  ["POST", "/mcp", "read"],
  ["GET", "/mcp", "read"],
  ["DELETE", "/mcp", "read"],
];

/** Reads the registered routes from Fastify's tree print: "METHOD /api/v1/..." without HEAD. */
export function registeredApiRoutes(tree: string): string[] {
  const stack: string[] = [];
  const found: string[] = [];
  for (const line of tree.split("\n")) {
    const match = /^((?:[│ ] {3})*)(?:├|└)── (.+?) \(([A-Z, ]+)\)$/.exec(line);
    if (!match) continue;
    const depth = (match[1] as string).length / 4;
    stack.length = depth;
    stack[depth] = match[2] as string;
    const path = stack.join("").replace(/\/+/g, "/");
    if (!path.startsWith("/api/v1/")) continue;
    for (const method of (match[3] as string).split(", ")) {
      if (method !== "HEAD") found.push(`${method} ${path.replace("/api/v1", "")}`);
    }
  }
  return found.toSorted();
}

/** Routes of the sign-in flows, the account's own pages and the admin (not user data). */
export const isAccountRoute = (route: string): boolean => /^[A-Z]+ \/(auth|account|admin)(\/|$)/.test(route);

const shape = (path: string) =>
  path
    .replace(/\?.*$/, "")
    .replace(/\/\d+(?=\/|$)/g, "/:id")
    .replace(/\/[a-f0-9]{32}(?=\/|$)/, "/:uploadId")
    .replace(/(?<=^\/attachments\/:id\/)(?!meta$)[^/]+$/, ":name")
    .replace(/(?<=^\/restore\/backups\/)[^/]+$/, ":fileName")
    .replace(/\/\d{4}-\d{2}-\d{2}(?=\/|$)/g, "/:on");

/** Status of every matrix route for one caller, as "METHOD path -> status" lines. */
const statuses = async (call: (method: string, url: string) => Promise<{ statusCode: number }>) =>
  Promise.all(
    MATRIX.map(
      async ([method, path]) =>
        [`${method} ${path}`, (await call(method, `/api/v1${path}`)).statusCode] as const,
    ),
  );
const routesWith = (access: Access[]) =>
  MATRIX.flatMap(([method, path, a]) => (access.includes(a) ? [`${method} ${path}`] : []));

/** One character percent-encoded ("a" -> "%61"). */
const hex = (c: string) => `%${c.charCodeAt(0).toString(16)}`;

/** Encoded spellings of an API path that the router still matches (the last one it does not). */
const variants = (path: string) => [
  `/${hex("a")}pi/v1${path}`,
  `/api/${hex("v")}1${path}`,
  `/api/v1/${hex(path.charAt(1))}${path.slice(2)}`,
  `/api${hex("/")}v1${path}`,
];

describe("access on every API route", () => {
  it("lists every registered route in the matrix, so a new route needs a decision here", async () => {
    const t = await makeApp();
    const registered = registeredApiRoutes(t.app.printRoutes({ commonPrefix: false }));
    const expected = MATRIX.map(([method, path]) =>
      `${method} ${shape(path)}`.replace(/:\w+/g, ":p"),
    ).toSorted();
    // /health is public and checked in security.test.ts, the calendar feed (secret link) in calendar.test.ts;
    // the sign-in, account and admin routes have
    // their own access rules and tests (auth-*.test.ts, admin.test.ts).
    const real = registered
      .filter((route) => route !== "GET /health" && route !== "GET /calendar/:file" && !isAccountRoute(route))
      .map((route) => route.replace(/:\w+/g, ":p"))
      .toSorted();
    expect(real).toEqual(expected);
  });

  it("answers 401 to every route without a session or token", async () => {
    const t = await makeApp();
    const rows = await statuses((method, url) => t.app.inject({ method: method as "GET", url }));
    expect(rows.filter(([, status]) => status !== 401)).toEqual([]);
  });

  it("answers 401 to percent-encoded paths of every route too (the router decodes them)", async () => {
    const t = await makeApp();
    const rows = (
      await Promise.all(
        MATRIX.flatMap(([method, path]) =>
          variants(path).map(async (url) => {
            const res = await t.app.inject({ method: method as "GET", url });
            return [`${method} ${url}`, res.statusCode] as const;
          }),
        ),
      )
    ).filter(([, status]) => status !== 401);
    expect(rows).toEqual([]);
    // An encoded path still gets the route's own rules: a read token stays out of write and session routes.
    const raw = t.token("reader", "read");
    const denied = await Promise.all(
      MATRIX.filter(([, , access]) => access !== "read").map(
        async ([method, path]) => (await t.withToken(raw, method as "GET", `/%61pi/v1${path}`)).statusCode,
      ),
    );
    expect(denied.every((status) => status === 403)).toBe(true);
  });

  it("lets a read token only do the read routes and keeps it out of the rest", async () => {
    const t = await makeApp();
    const raw = t.token("reader", "read");
    const rows = await statuses((method, url) => t.withToken(raw, method as "GET", url));
    expect(rows.filter(([, status]) => status === 403).map(([route]) => route)).toEqual(
      routesWith(["write", "session"]),
    );
    expect(rows.filter(([, status]) => status === 401)).toEqual([]);
  });

  it("lets a write token do everything except the session-only routes", async () => {
    const t = await makeApp();
    const raw = t.token("writer", "write");
    const rows = await statuses((method, url) => t.withToken(raw, method as "GET", url));
    expect(rows.filter(([, status]) => status === 403).map(([route]) => route)).toEqual(
      routesWith(["session"]),
    );
    expect(rows.filter(([, status]) => status === 401)).toEqual([]);
  });

  it("lets the session reach every route", async () => {
    const t = await makeApp();
    // /export.zip streams a zip, covered in the export tests
    const rows = await statuses((method, url) =>
      url.endsWith("/export.zip") ? Promise.resolve({ statusCode: 200 }) : t.call(method as "GET", url),
    );
    expect(rows.filter(([, status]) => status === 401 || status === 403)).toEqual([]);
  });

  it("keeps a revoked token out of the new routes too", async () => {
    const t = await makeApp();
    const { raw: value, token } = await t.create<{ raw: string; token: { id: number } }>("/api/v1/tokens", {
      name: "gone",
      scope: "write",
    });
    expect((await t.call("DELETE", `/api/v1/tokens/${token.id}`)).statusCode).toBeLessThan(300);
    expect((await t.withToken(value, "GET", "/api/v1/search?q=abc")).statusCode).toBe(401);
    expect((await t.withToken(value, "GET", "/api/v1/export.zip")).statusCode).toBe(401);
  });
});
