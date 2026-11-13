import { statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { apiTokens, events } from "../src/db/schema.ts";
import { CORS_EXPOSE_HEADERS } from "../src/http/cors.ts";
import { HSTS } from "../src/http/security.ts";
import { hashToken } from "../src/services/tokens.ts";
import { makeApp, type TestApp } from "./helpers.ts";

const WEB = "http://localhost:5181";

const authHeaders = (t: TestApp) => t.account.headers();

const preflight = (t: TestApp, origin: string) =>
  t.app.inject({
    method: "OPTIONS",
    url: "/api/v1/todos",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization, content-type",
    },
  });

const https = (t: TestApp, remoteAddress: string) =>
  t.app.inject({
    method: "GET",
    url: "/api/v1/health",
    remoteAddress,
    headers: { "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.9" },
  });

describe("host allowlist", () => {
  it("answers 421 for an unknown Host, also for static files and health", async () => {
    const t = await makeApp();
    const urls = ["/api/v1/health", "/", "/assets/app-abc123.js", "/api/v1/todos"];
    const responses = await Promise.all(
      urls.map((url) =>
        t.app.inject({ method: "GET", url, headers: { ...authHeaders(t), host: "evil.example:4711" } }),
      ),
    );
    expect(responses.map((res) => res.statusCode)).toEqual([421, 421, 421, 421]);
    expect(responses.map((res) => res.json().error.code)).toEqual(Array(4).fill("unknown_host"));
  });

  it("accepts every allowed host name on any port", async () => {
    const t = await makeApp();
    const hosts = ["organizerapi.omeldar.cloud", "localhost:4711", "127.0.0.1:9999", "LOCALHOST:1"];
    const responses = await Promise.all(
      hosts.map((host) => t.app.inject({ method: "GET", url: "/api/v1/health", headers: { host } })),
    );
    expect(responses.map((res) => res.statusCode)).toEqual([200, 200, 200, 200]);
  });
});

describe("CORS", () => {
  it("answers a preflight from the web app's origin, never with credentials", async () => {
    const t = await makeApp();
    const res = await preflight(t, WEB);
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(WEB);
    expect(res.headers["access-control-allow-methods"]).toContain("PATCH");
    expect(res.headers["access-control-allow-headers"]).toContain("authorization");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(res.headers.vary).toContain("Origin");
  });

  it("refuses a preflight from another origin (403)", async () => {
    const t = await makeApp();
    const res = await preflight(t, "https://evil.example");
    expect(res.statusCode).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("lets the web app read answers and the file name of downloads, other origins not", async () => {
    const t = await makeApp();
    const ok = await t.call("GET", "/api/v1/todos", undefined, { origin: WEB });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["access-control-allow-origin"]).toBe(WEB);
    expect(ok.headers["access-control-expose-headers"]).toBe(CORS_EXPOSE_HEADERS);
    expect(CORS_EXPOSE_HEADERS).toContain("content-disposition");
    expect(ok.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(ok.headers.vary).toContain("Origin");

    const other = await t.call("GET", "/api/v1/todos", undefined, { origin: "https://evil.example" });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
    expect(other.headers.vary).toContain("Origin");
  });
});

describe("cross-site protection", () => {
  it("rejects a write with a foreign Origin (403) even with a valid session", async () => {
    const t = await makeApp();
    const res = await t.call("POST", "/api/v1/projects", { name: "X" }, { origin: "https://evil.example" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
    const nullOrigin = await t.call("POST", "/api/v1/projects", { name: "X" }, { origin: "null" });
    expect(nullOrigin.statusCode).toBe(403);
  });

  it("allows writes from the web app's origin and from clients that send no Origin", async () => {
    const t = await makeApp();
    expect((await t.call("POST", "/api/v1/projects", { name: "X" }, { origin: WEB })).statusCode).toBe(201);
    const raw = t.token("assistant", "write");
    expect((await t.withToken(raw, "POST", "/api/v1/projects", { name: "Y" })).statusCode).toBe(201);
  });
});

describe("authentication", () => {
  it("serves health without auth and answers 401 elsewhere without a token", async () => {
    const t = await makeApp();
    expect((await t.app.inject({ method: "GET", url: "/api/v1/health" })).json()).toEqual({
      ok: true,
      version: "0.1.0",
    });
    const urls = ["/api/v1/me", "/api/v1/todos", "/api/v1/export.zip", "/api/v1/account"];
    const responses = await Promise.all(urls.map((url) => t.app.inject({ method: "GET", url })));
    expect(responses.map((res) => res.statusCode)).toEqual([401, 401, 401, 401]);
    expect(responses.map((res) => res.json().error.code)).toEqual(Array(4).fill("unauthorized"));
  });

  it("rejects malformed and unknown bearer values (401) and never sets a cookie", async () => {
    const t = await makeApp();
    for (const authorization of ["Bearer", "Basic abc", "Bearer not-a-token", `Bearer ${"x".repeat(600)}`]) {
      // oxlint-disable-next-line no-await-in-loop -- one call after the other
      const res = await t.app.inject({ method: "GET", url: "/api/v1/me", headers: { authorization } });
      expect(res.statusCode).toBe(401);
    }
    const me = await t.call("GET", "/api/v1/me");
    expect(me.json()).toMatchObject({ via: "session", account: { username: "anna" } });
    expect(me.headers["set-cookie"]).toBeUndefined();
  });
});

describe("behind the proxy", () => {
  it("trusts X-Forwarded-* only from the configured proxies and then sends HSTS", async () => {
    const t = await makeApp({ env: { SLOPPANIZER_TRUSTED_PROXIES: "172.16.0.0/12" } });
    expect((await https(t, "172.18.0.2")).headers["strict-transport-security"]).toBe(HSTS);
    expect((await https(t, "198.51.100.7")).headers["strict-transport-security"]).toBeUndefined();
    const untrusting = await makeApp();
    expect((await https(untrusting, "172.18.0.2")).headers["strict-transport-security"]).toBeUndefined();
  });
});

describe("rate limits", () => {
  it("limits API calls per account and says when to try again", async () => {
    const t = await makeApp();
    const bo = await t.asAccount({ username: "bo" });
    const statuses = await Promise.all(
      Array.from({ length: 601 }, () => t.call("GET", "/api/v1/me").then((res) => res.statusCode)),
    );
    expect(statuses.filter((s) => s === 200)).toHaveLength(600);
    const limited = await t.call("GET", "/api/v1/me");
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(limited.json().error.details.retryAfterSeconds).toBe(Number(limited.headers["retry-after"]));
    // Another account is not affected; after the window the first one may call again.
    expect((await bo.call("GET", "/api/v1/me")).statusCode).toBe(200);
    t.advance(61_000);
    expect((await t.call("GET", "/api/v1/me")).statusCode).toBe(200);
  });
});

describe("tokens", () => {
  it("lets a read token GET but not change (403)", async () => {
    const t = await makeApp();
    const raw = t.token("reader", "read");
    expect((await t.withToken(raw, "GET", "/api/v1/todos")).statusCode).toBe(200);
    expect((await t.withToken(raw, "GET", "/api/v1/me")).json()).toMatchObject({
      actor: "reader",
      via: "token",
      scope: "read",
      account: { username: "anna" },
    });
    const write = await t.withToken(raw, "POST", "/api/v1/todos", { title: "No" });
    expect(write.statusCode).toBe(403);
    expect(write.json().error.code).toBe("forbidden");
    expect((await t.withToken(raw, "GET", "/api/v1/export.zip")).statusCode).toBe(403);
  });

  it("lets a write token change things and records its name as the actor", async () => {
    const t = await makeApp();
    const raw = t.token("assistant", "write");
    const res = await t.withToken(raw, "POST", "/api/v1/todos", { title: "From a script" });
    expect(res.statusCode).toBe(201);
    const rows = t.deps.db.select().from(events).all();
    expect(rows.map((e) => [e.kind, e.actor])).toEqual([["created", "assistant"]]);
    expect((await t.withToken(raw, "GET", "/api/v1/export.zip")).statusCode).toBe(200);
  });

  it("blocks every token from the session-only token routes", async () => {
    const t = await makeApp();
    const raw = t.token("assistant", "write");
    expect((await t.withToken(raw, "GET", "/api/v1/tokens")).statusCode).toBe(403);
    expect(
      (await t.withToken(raw, "POST", "/api/v1/tokens", { name: "more", scope: "write" })).statusCode,
    ).toBe(403);
    expect((await t.withToken(raw, "DELETE", "/api/v1/tokens/1")).statusCode).toBe(403);
  });

  it("creates a token through the session, returns the raw value once and stores only its hash", async () => {
    const t = await makeApp();
    const res = await t.call("POST", "/api/v1/tokens", { name: "cli", scope: "read" });
    expect(res.statusCode).toBe(201);
    const { token, raw } = res.json();
    expect(raw).toMatch(/^spz_[0-9A-Za-z]{40}$/);
    expect(token.prefix).toBe(raw.slice(0, 12));
    const stored = t.deps.db.select().from(apiTokens).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHash).toBe(hashToken(raw));
    expect(JSON.stringify(stored)).not.toContain(raw);
    const list = (await t.call("GET", "/api/v1/tokens")).json();
    expect(JSON.stringify(list)).not.toContain(raw);
    expect(list[0]).not.toHaveProperty("raw");
    expect((await t.withToken(raw, "GET", "/api/v1/me")).json().actor).toBe("cli");
  });

  it("reserves the name you and keeps active token names unique", async () => {
    const t = await makeApp();
    const reserved = await t.call("POST", "/api/v1/tokens", { name: " You ", scope: "write" });
    expect(reserved.statusCode).toBe(422);
    expect(reserved.json().error.message).toContain('"you" is reserved');
    const first = await t.call("POST", "/api/v1/tokens", { name: "mcp", scope: "write" });
    expect(first.statusCode).toBe(201);
    const again = await t.call("POST", "/api/v1/tokens", { name: "MCP", scope: "read" });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toContain('A token named "mcp" exists already');
    expect(() => t.token("you", "write")).toThrow(/reserved/);
    await t.call("DELETE", `/api/v1/tokens/${first.json().token.id}`);
    expect((await t.call("POST", "/api/v1/tokens", { name: "mcp", scope: "write" })).statusCode).toBe(201);
  });

  it("rejects revoked, expired and unknown tokens (401)", async () => {
    const t = await makeApp();
    const created = (await t.call("POST", "/api/v1/tokens", { name: "old", scope: "write" })).json();
    expect((await t.call("DELETE", `/api/v1/tokens/${created.token.id}`)).statusCode).toBe(204);
    expect((await t.withToken(created.raw, "GET", "/api/v1/me")).statusCode).toBe(401);
    expect((await t.call("GET", "/api/v1/tokens")).json()[0].revokedAt).not.toBeNull();

    const expiring = t.token("short", "read", "2026-11-11T11:00:00.000Z");
    expect((await t.withToken(expiring, "GET", "/api/v1/me")).statusCode).toBe(200);
    t.setNow("2026-11-11T11:00:00.000Z");
    expect((await t.withToken(expiring, "GET", "/api/v1/me")).statusCode).toBe(401);

    const unknown = `spz_${"a".repeat(40)}`;
    expect((await t.withToken(unknown, "GET", "/api/v1/me")).statusCode).toBe(401);
    expect((await t.withToken("not-a-token", "GET", "/api/v1/me")).statusCode).toBe(401);
    expect((await t.call("DELETE", "/api/v1/tokens/999")).statusCode).toBe(404);
  });

  it("updates last_used_at at most once a minute", async () => {
    const t = await makeApp();
    const raw = t.token("reader", "read");
    await t.withToken(raw, "GET", "/api/v1/me");
    const first = t.deps.db.select().from(apiTokens).get()?.lastUsedAt;
    expect(first).toBe("2026-11-11T10:00:00.000Z");
    t.advance(30_000);
    await t.withToken(raw, "GET", "/api/v1/me");
    expect(t.deps.db.select().from(apiTokens).get()?.lastUsedAt).toBe(first);
    t.advance(30_000);
    await t.withToken(raw, "GET", "/api/v1/me");
    expect(t.deps.db.select().from(apiTokens).get()?.lastUsedAt).toBe("2026-11-11T10:01:00.000Z");
  });
});

describe("headers and files", () => {
  it("sends the basic headers everywhere and no-store on JSON", async () => {
    const t = await makeApp();
    for (const res of [
      await t.app.inject({ method: "GET", url: "/" }),
      await t.call("GET", "/api/v1/todos"),
      await t.app.inject({ method: "GET", url: "/assets/app-abc123.js" }),
    ]) {
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      expect(res.headers["x-frame-options"]).toBe("DENY");
    }
    expect((await t.call("GET", "/api/v1/todos")).headers["cache-control"]).toBe("no-store");
  });

  it("answers 404 JSON for unknown API routes", async () => {
    const t = await makeApp();
    const res = await t.call("GET", "/api/v1/nope");
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("serves the OpenAPI document and the self-hosted docs UI to a session", async () => {
    const t = await makeApp();
    const spec = (await t.call("GET", "/api/openapi.json")).json();
    expect(spec.openapi).toMatch(/^3\./);
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        "/api/v1/todos",
        "/api/v1/todos/{id}",
        "/api/v1/next",
        "/api/v1/notes",
        "/api/v1/attachments",
        "/api/v1/search",
        "/api/v1/settings",
        "/api/v1/restore",
        "/api/v1/restore/{uploadId}/apply",
        "/api/v1/restore/backups/{fileName}",
      ]),
    );
    expect(Object.keys(spec.paths)).not.toContain("/api/v1/export/folder");
    const docs = await t.call("GET", "/api/docs/");
    expect(docs.statusCode).toBe(200);
    expect(docs.body).not.toMatch(/cdn|unpkg|jsdelivr/i);
  });

  it("keeps the data dir, the secret and the files folders private", async () => {
    const t = await makeApp();
    expect(statSync(t.dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(`${t.dataDir}/secret`).mode & 0o777).toBe(0o600);
    expect(statSync(t.filesDir).mode & 0o777).toBe(0o700);
  });
});
