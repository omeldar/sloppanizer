import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeApp, type TestApp } from "./helpers.ts";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const verifier = () => randomBytes(32).toString("base64url");
const challengeOf = (v: string) => createHash("sha256").update(v).digest("base64url");

async function register(t: TestApp, body: unknown = { client_name: "Claude", redirect_uris: [REDIRECT] }) {
  return t.app.inject({ method: "POST", url: "/oauth/register", payload: body as Record<string, unknown> });
}

/** Registration, consent and code exchange: the whole flow an MCP client runs. */
async function connect(t: TestApp, options: { grant?: "read" | "write"; scope?: string } = {}) {
  const client = (await register(t)).json() as { client_id: string };
  const v = verifier();
  const params = {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challengeOf(v),
    code_challenge_method: "S256",
    state: "xyz",
    ...(options.scope ? { scope: options.scope } : {}),
  };
  const approved = await t.call("POST", "/api/v1/auth/oauth/approve", {
    ...params,
    grant: options.grant ?? "write",
  });
  expect(approved.statusCode).toBe(200);
  const redirectTo = new URL((approved.json() as { redirectTo: string }).redirectTo);
  expect(redirectTo.searchParams.get("state")).toBe("xyz");
  const code = redirectTo.searchParams.get("code") ?? "";
  const token = await t.app.inject({
    method: "POST",
    url: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: v,
      client_id: client.client_id,
      redirect_uri: REDIRECT,
    }).toString(),
  });
  expect(token.statusCode).toBe(200);
  return {
    clientId: client.client_id,
    code,
    v,
    tokens: token.json() as {
      access_token: string;
      refresh_token: string;
      scope: string;
      expires_in: number;
    },
  };
}

const tokenCall = (t: TestApp, body: Record<string, string>) =>
  t.app.inject({
    method: "POST",
    url: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(body).toString(),
  });

const mcpList = (t: TestApp, raw: string) =>
  t.app.inject({
    method: "POST",
    url: "/api/v1/mcp",
    headers: {
      authorization: `Bearer ${raw}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });

describe("OAuth for MCP clients", () => {
  it("publishes discovery metadata and points 401s of the MCP endpoint at it", async () => {
    const t = await makeApp();
    const unauthorized = await t.app.inject({ method: "POST", url: "/api/v1/mcp", payload: {} });
    expect(unauthorized.statusCode).toBe(401);
    const header = String(unauthorized.headers["www-authenticate"]);
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(header)?.[1] ?? "";
    expect(metadataUrl).toMatch(/\/\.well-known\/oauth-protected-resource\/api\/v1\/mcp$/);

    const resource = await t.app.inject({ method: "GET", url: new URL(metadataUrl).pathname });
    expect(resource.statusCode).toBe(200);
    const { authorization_servers, resource: id } = resource.json() as {
      authorization_servers: string[];
      resource: string;
    };
    expect(id).toMatch(/\/api\/v1\/mcp$/);
    const server = await t.app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server" });
    const meta = server.json() as Record<string, unknown>;
    expect(meta.issuer).toBe(authorization_servers[0]);
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(String(meta.registration_endpoint)).toMatch(/\/oauth\/register$/);
  });

  it("runs the whole flow: register, consent, code, MCP call, refresh", async () => {
    const t = await makeApp();
    const { tokens, clientId } = await connect(t);
    expect(tokens.scope).toBe("write");
    expect((await mcpList(t, tokens.access_token)).statusCode).toBe(200);

    // The grant shows on the tokens page under the client's name.
    const list = (await t.call("GET", "/api/v1/tokens")).json() as { name: string }[];
    expect(list.map((x) => x.name)).toContain("Claude");

    const refreshed = await tokenCall(t, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    expect(refreshed.statusCode).toBe(200);
    const next = refreshed.json() as { access_token: string; refresh_token: string };
    expect(next.access_token).not.toBe(tokens.access_token);
    expect((await mcpList(t, tokens.access_token)).statusCode).toBe(401);
    expect((await mcpList(t, next.access_token)).statusCode).toBe(200);
    // The old refresh token is used up.
    const again = await tokenCall(t, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    expect(again.statusCode).toBe(400);
    expect((again.json() as { error: string }).error).toBe("invalid_grant");
  });

  it("uses a code only once and only with the right PKCE verifier", async () => {
    const t = await makeApp();
    const { code, v, clientId } = await connect(t);
    const reuse = await tokenCall(t, {
      grant_type: "authorization_code",
      code,
      code_verifier: v,
      client_id: clientId,
    });
    expect(reuse.statusCode).toBe(400);

    const client = (await register(t)).json() as { client_id: string };
    const approved = await t.call("POST", "/api/v1/auth/oauth/approve", {
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_challenge: challengeOf(verifier()),
      code_challenge_method: "S256",
      grant: "write",
    });
    const fresh =
      new URL((approved.json() as { redirectTo: string }).redirectTo).searchParams.get("code") ?? "";
    const wrong = await tokenCall(t, {
      grant_type: "authorization_code",
      code: fresh,
      code_verifier: verifier(),
    });
    expect((wrong.json() as { error: string }).error).toBe("invalid_grant");
  });

  it("ends the grant when its token is revoked on the tokens page", async () => {
    const t = await makeApp();
    const { tokens } = await connect(t);
    const list = (await t.call("GET", "/api/v1/tokens")).json() as { id: number; name: string }[];
    const id = list.find((x) => x.name === "Claude")?.id;
    expect((await t.call("DELETE", `/api/v1/tokens/${id}`)).statusCode).toBeLessThan(300);
    expect((await mcpList(t, tokens.access_token)).statusCode).toBe(401);
    const refreshed = await tokenCall(t, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    expect(refreshed.statusCode).toBe(400);
  });

  it("revokes through the revocation endpoint", async () => {
    const t = await makeApp();
    const { tokens } = await connect(t);
    const res = await tokenCall(t, { token: tokens.refresh_token });
    expect(res.statusCode).toBe(400);
    const revoked = await t.app.inject({
      method: "POST",
      url: "/oauth/revoke",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `token=${tokens.refresh_token}`,
    });
    expect(revoked.statusCode).toBe(200);
    expect((await mcpList(t, tokens.access_token)).statusCode).toBe(401);
  });

  it("gives read-only access when the user picks it or the client asks only for read", async () => {
    const t = await makeApp();
    const picked = await connect(t, { grant: "read" });
    expect(picked.tokens.scope).toBe("read");
    const asked = await connect(t, { scope: "read", grant: "write" });
    expect(asked.tokens.scope).toBe("read");
  });

  it("replaces the grant when the same app connects again", async () => {
    const t = await makeApp();
    const first = await connect(t);
    // A new registration is a new client; the same client connecting again replaces its grant.
    const v = verifier();
    const approved = await t.call("POST", "/api/v1/auth/oauth/approve", {
      response_type: "code",
      client_id: first.clientId,
      redirect_uri: REDIRECT,
      code_challenge: challengeOf(v),
      code_challenge_method: "S256",
      grant: "write",
    });
    const code =
      new URL((approved.json() as { redirectTo: string }).redirectTo).searchParams.get("code") ?? "";
    expect(
      (await tokenCall(t, { grant_type: "authorization_code", code, code_verifier: v })).statusCode,
    ).toBe(200);
    expect((await mcpList(t, first.tokens.access_token)).statusCode).toBe(401);
  });

  it("describes the request for the consent page and refuses foreign redirect URIs", async () => {
    const t = await makeApp();
    const client = (await register(t)).json() as { client_id: string };
    const base = {
      response_type: "code",
      client_id: client.client_id,
      code_challenge: challengeOf(verifier()),
      code_challenge_method: "S256",
      state: "s1",
    };
    const ok = await t.app.inject({
      method: "GET",
      url: `/api/v1/auth/oauth/request?${new URLSearchParams({ ...base, redirect_uri: REDIRECT })}`,
    });
    expect(ok.statusCode).toBe(200);
    const described = ok.json() as { clientName: string; redirectHost: string; denyUrl: string };
    expect(described.clientName).toBe("Claude");
    expect(described.redirectHost).toBe("claude.ai");
    expect(new URL(described.denyUrl).searchParams.get("error")).toBe("access_denied");

    const evil = await t.app.inject({
      method: "GET",
      url: `/api/v1/auth/oauth/request?${new URLSearchParams({ ...base, redirect_uri: "https://evil.example/cb" })}`,
    });
    expect(evil.statusCode).toBe(400);
    expect((evil.json() as { denyUrl?: string }).denyUrl).toBeUndefined();

    const browser = await t.app.inject({
      method: "GET",
      url: `/oauth/authorize?${new URLSearchParams({ ...base, redirect_uri: REDIRECT })}`,
    });
    expect(browser.statusCode).toBe(302);
    expect(String(browser.headers.location)).toMatch(/\/oauth\/authorize\?.*client_id=/);
    const badBrowser = await t.app.inject({
      method: "GET",
      url: `/oauth/authorize?${new URLSearchParams({ ...base, redirect_uri: "https://evil.example/cb" })}`,
    });
    expect(badBrowser.statusCode).toBe(400);
  });

  it("refuses unsafe redirect URIs at registration and allows any loopback port", async () => {
    const t = await makeApp();
    const refused = await Promise.all(
      ["http://example.com/cb", "javascript:alert(1)", "https://a.example/cb#frag"].map(
        async (uri) => (await register(t, { redirect_uris: [uri] })).statusCode,
      ),
    );
    expect(refused).toEqual([400, 400, 400]);
    const local = (
      await register(t, { client_name: "Claude Code", redirect_uris: ["http://localhost:33418/callback"] })
    ).json() as {
      client_id: string;
    };
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/auth/oauth/request?${new URLSearchParams({
        response_type: "code",
        client_id: local.client_id,
        redirect_uri: "http://localhost:50123/callback",
        code_challenge: challengeOf(verifier()),
        code_challenge_method: "S256",
      })}`,
    });
    expect(res.statusCode).toBe(200);
  });

  it("lets only a browser session approve, never a token", async () => {
    const t = await makeApp();
    const client = (await register(t)).json() as { client_id: string };
    const raw = t.token("script", "write");
    const res = await t.withToken(raw, "POST", "/api/v1/auth/oauth/approve", {
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_challenge: challengeOf(verifier()),
      code_challenge_method: "S256",
      grant: "write",
    });
    expect(res.statusCode).toBe(403);
  });

  it("answers CORS for any origin on the token endpoint, without the Origin check", async () => {
    const t = await makeApp();
    const preflight = await t.app.inject({
      method: "OPTIONS",
      url: "/oauth/token",
      headers: { origin: "https://inspector.example", "access-control-request-method": "POST" },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("*");
    const res = await t.app.inject({
      method: "POST",
      url: "/oauth/register",
      headers: { origin: "https://inspector.example" },
      payload: { redirect_uris: [REDIRECT] },
    });
    expect(res.statusCode).toBe(201);
  });
});
