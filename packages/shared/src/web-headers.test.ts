import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, isAppPath, webSecurityHeaders } from "./web-headers.ts";

const hosted = { apiOrigin: "https://organizerapi.omeldar.cloud" };
const directive = (csp: string, name: string) =>
  csp.split("; ").find((part) => part === name || part.startsWith(`${name} `));

describe("webSecurityHeaders", () => {
  it("lets the hosted page fetch only itself and the API, over https", () => {
    const csp = contentSecurityPolicy(hosted);
    expect(directive(csp, "connect-src")).toBe(
      "connect-src 'self' https://organizerapi.omeldar.cloud http://localhost:* http://127.0.0.1:*",
    );
    expect(directive(csp, "script-src")).toBe("script-src 'self'");
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(directive(csp, "base-uri")).toBe("base-uri 'none'");
    // Not set: it would turn the fetch to a local Ollama into https.
    expect(csp).not.toContain("upgrade-insecure-requests");
    expect(csp).not.toContain("unsafe-eval");
    expect(directive(csp, "script-src")).not.toContain("unsafe-inline");
  });

  it("uses only the origin of an API URL with a path or trailing slash", () => {
    const csp = contentSecurityPolicy({ apiOrigin: "https://api.example.test/api/v1/" });
    expect(directive(csp, "connect-src")).toBe(
      "connect-src 'self' https://api.example.test http://localhost:* http://127.0.0.1:*",
    );
  });

  it("refuses an API origin that is not a URL", () => {
    expect(() => contentSecurityPolicy({ apiOrigin: "organizerapi" })).toThrow(/not a URL/);
  });

  it("keeps the local web mode on its own origin, without https upgrades or HSTS", () => {
    const headers = new Map(webSecurityHeaders({ apiOrigin: null }));
    const csp = headers.get("Content-Security-Policy") ?? "";
    expect(directive(csp, "connect-src")).toBe("connect-src 'self' http://localhost:* http://127.0.0.1:*");
    expect(csp).not.toContain("upgrade-insecure-requests");
    expect(headers.has("Strict-Transport-Security")).toBe(false);
  });

  it("does not upgrade a local http API to https (vite preview in the e2e run)", () => {
    const headers = new Map(webSecurityHeaders({ apiOrigin: "http://127.0.0.1:4804" }));
    const csp = headers.get("Content-Security-Policy") ?? "";
    expect(directive(csp, "connect-src")).toBe(
      "connect-src 'self' http://127.0.0.1:4804 http://localhost:* http://127.0.0.1:*",
    );
    expect(csp).not.toContain("upgrade-insecure-requests");
    expect(headers.has("Strict-Transport-Security")).toBe(false);
  });

  it("sends HSTS, framing, sniffing, referrer and isolation headers on the hosted site", () => {
    const headers = new Map(webSecurityHeaders(hosted));
    expect(headers.get("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(headers.get("Permissions-Policy")).toContain("publickey-credentials-get=(self)");
    expect(headers.get("Permissions-Policy")).toContain("camera=()");
  });

  it("names every header once", () => {
    const names = webSecurityHeaders(hosted).map(([name]) => name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("isAppPath", () => {
  it.each([
    "/u",
    "/u/",
    "/u/anna/",
    "/u/anna/todos/1",
    "/login",
    "/signup",
    "/setup",
    "/reset",
    "/login/",
    "/draw",
  ])("%s is the app", (path) => expect(isAppPath(path)).toBe(true));
  it.each([
    "/",
    "/index.html",
    "/assets/app.js",
    "/user",
    "/loginx",
    "/favicon.svg",
    "/404.html",
    "/drawing",
  ])("%s is not the app", (path) => expect(isAppPath(path)).toBe(false));
});
