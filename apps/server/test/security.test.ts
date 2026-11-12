import { statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { apiTokens, events } from "../src/db/schema.ts";
import { CSP, SESSION_COOKIE } from "../src/http/security.ts";
import { hashToken } from "../src/services/tokens.ts";
import { makeApp, TEST_INDEX_HTML } from "./helpers.ts";

describe("host allowlist", () => {
  it("answers 421 for an unknown Host, also for static files and health", async () => {
    const t = await makeApp();
    const urls = ["/api/v1/health", "/", "/assets/app-abc123.js", "/api/v1/todos"];
    const responses = await Promise.all(
      urls.map((url) =>
        t.app.inject({ method: "GET", url, headers: { host: "evil.example:4711", cookie: t.cookie } }),
      ),
    );
    expect(responses.map((res) => res.statusCode)).toEqual([421, 421, 421, 421]);
    expect(responses.map((res) => res.json().error.code)).toEqual(Array(4).fill("unknown_host"));
  });

  it("accepts every allowed host name on any port", async () => {
    const t = await makeApp();
    const hosts = ["organizer.localhost:4711", "localhost", "127.0.0.1:9999", "[::1]:4711", "LOCALHOST:1"];
    const responses = await Promise.all(
      hosts.map((host) => t.app.inject({ method: "GET", url: "/api/v1/health", headers: { host } })),
    );
    expect(responses.map((res) => res.statusCode)).toEqual([200, 200, 200, 200, 200]);
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

  it("allows a write whose Origin is an allowed host on another port (Vite dev)", async () => {
    const t = await makeApp();
    const res = await t.call("POST", "/api/v1/projects", { name: "X" }, { origin: "http://localhost:5181" });
    expect(res.statusCode).toBe(201);
  });

  it("rejects Sec-Fetch-Site: cross-site (403), allows same-origin", async () => {
    const t = await makeApp();
    const bad = await t.call("POST", "/api/v1/projects", { name: "X" }, { "sec-fetch-site": "cross-site" });
    expect(bad.statusCode).toBe(403);
    const badGet = await t.call("GET", "/api/v1/todos", undefined, { "sec-fetch-site": "cross-site" });
    expect(badGet.statusCode).toBe(403);
    const ok = await t.call("POST", "/api/v1/projects", { name: "X" }, { "sec-fetch-site": "same-origin" });
    expect(ok.statusCode).toBe(201);
  });
});

describe("authentication", () => {
  it("serves health without auth and answers 401 elsewhere without a session or token", async () => {
    const t = await makeApp();
    expect((await t.app.inject({ method: "GET", url: "/api/v1/health" })).json()).toEqual({
      ok: true,
      version: "0.1.0",
    });
    const urls = ["/api/v1/me", "/api/v1/todos", "/api/v1/export.zip", "/api/openapi.json", "/api/docs/"];
    const responses = await Promise.all(urls.map((url) => t.app.inject({ method: "GET", url })));
    expect(responses.map((res) => res.statusCode)).toEqual([401, 401, 401, 401, 401]);
    expect(responses.map((res) => res.json().error.code)).toEqual(Array(5).fill("unauthorized"));
  });

  it("rejects a session cookie with a wrong signature", async () => {
    const t = await makeApp();
    const forged = t.cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    const res = await t.app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: forged } });
    expect(res.statusCode).toBe(401);
    const unsigned = await t.app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: `${SESSION_COOKIE}=s1.abc` },
    });
    expect(unsigned.statusCode).toBe(401);
  });

  it("sets a strict HttpOnly session cookie with the app HTML; the session acts as you", async () => {
    const t = await makeApp();
    const page = await t.app.inject({
      method: "GET",
      url: "/projects/home-lab",
      headers: { accept: "text/html" },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toBe(TEST_INDEX_HTML);
    const cookie = String(page.headers["set-cookie"]);
    expect(cookie).toMatch(/^org_session=/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Secure");
    expect((await t.call("GET", "/api/v1/me")).json()).toEqual({
      actor: "you",
      via: "session",
      scope: "write",
    });
  });

  it("serves the placeholder page (with the cookie) when the web app is not built", async () => {
    const t = await makeApp({ noWebBuild: true });
    const page = await t.app.inject({ method: "GET", url: "/" });
    expect(page.body).toContain("not built");
    expect(page.headers["set-cookie"]).toBeDefined();
  });
});

describe("tokens", () => {
  it("lets a read token GET but not change (403)", async () => {
    const t = await makeApp();
    const raw = t.token("reader", "read");
    expect((await t.withToken(raw, "GET", "/api/v1/todos")).statusCode).toBe(200);
    expect((await t.withToken(raw, "GET", "/api/v1/me")).json()).toEqual({
      actor: "reader",
      via: "token",
      scope: "read",
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
    expect(raw).toMatch(/^org_[0-9A-Za-z]{40}$/);
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

    const unknown = `org_${"a".repeat(40)}`;
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
  it("sends the CSP on HTML and the basic headers everywhere", async () => {
    const t = await makeApp();
    const page = await t.app.inject({ method: "GET", url: "/" });
    expect(page.headers["content-security-policy"]).toBe(CSP);
    for (const res of [
      page,
      await t.call("GET", "/api/v1/todos"),
      await t.app.inject({ method: "GET", url: "/assets/app-abc123.js" }),
    ]) {
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      expect(res.headers["x-frame-options"]).toBe("DENY");
    }
  });

  it("serves assets with long caching and answers 404 JSON for unknown API routes and missing files", async () => {
    const t = await makeApp();
    const asset = await t.app.inject({ method: "GET", url: "/assets/app-abc123.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toContain("immutable");
    expect((await t.call("GET", "/api/v1/nope")).statusCode).toBe(404);
    expect((await t.app.inject({ method: "GET", url: "/assets/missing.js" })).statusCode).toBe(404);
  });

  it("serves the OpenAPI document and the self-hosted docs UI to a session", async () => {
    const t = await makeApp();
    const spec = (await t.call("GET", "/api/openapi.json")).json();
    expect(spec.openapi).toMatch(/^3\./);
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(["/api/v1/todos", "/api/v1/todos/{id}", "/api/v1/next"]),
    );
    const docs = await t.call("GET", "/api/docs/");
    expect(docs.statusCode).toBe(200);
    expect(docs.body).not.toMatch(/cdn|unpkg|jsdelivr/i);
  });

  it("creates the data dir with 0700 and the secret with 0600", async () => {
    const t = await makeApp();
    expect(statSync(t.dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(t.dataDir, "secret")).mode & 0o777).toBe(0o600);
    expect(statSync(join(t.dataDir, "attachments")).mode & 0o777).toBe(0o700);
    expect(t.deps.attachmentsDir).toBe(join(t.dataDir, "attachments"));
  });
});
