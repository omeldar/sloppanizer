import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ApiError, createApi, notReachableMessage, ToolError } from "./api.ts";

const TOKEN = `spz_${"a".repeat(40)}`;
const dir = mkdtempSync(join(tmpdir(), "sloppanizer-mcp-api-"));
const tokenFile = join(dir, "mcp-token");
writeFileSync(tokenFile, `${TOKEN}\n`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const config = { url: "http://127.0.0.1:4999", tokenFile, timeZone: "UTC" };

function fakeFetch(status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.init = init;
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }) as typeof fetch;
}

describe("createApi", () => {
  it("sends the token from the file and builds the query (lists as comma lists, no empty values)", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const api = createApi(config, fakeFetch(200, { ok: true }, seen));
    await api.get("/todos", {
      label: ["priority::high", "homelab"],
      projectId: "inbox",
      q: undefined,
      limit: 5,
    });
    expect(seen.url).toBe(
      "http://127.0.0.1:4999/api/v1/todos?label=priority%3A%3Ahigh%2Chomelab&projectId=inbox&limit=5",
    );
    const headers = (seen.init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("sends the shared project header only from inSpace", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const api = createApi(config, fakeFetch(200, { ok: true }, seen));
    await api.get("/todos");
    expect((seen.init?.headers ?? {}) as Record<string, string>).not.toHaveProperty("x-sloppanizer-space");
    await api.inSpace(7).patch("/todos/3", { assignee: "bo" });
    expect(((seen.init?.headers ?? {}) as Record<string, string>)["x-sloppanizer-space"]).toBe("7");
    await api.get("/todos");
    expect((seen.init?.headers ?? {}) as Record<string, string>).not.toHaveProperty("x-sloppanizer-space");
  });

  it("turns a failed connection into the start hint", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(createApi(config, failing).get("/stats")).rejects.toThrow(notReachableMessage(config.url));
    expect(notReachableMessage(config.url)).toBe(
      "Sloppanizer is not reachable at http://127.0.0.1:4999. Check the URL and your network.",
    );
  });

  it("keeps code, message and details of API errors", async () => {
    const body = {
      error: { code: "conflict", message: "ambiguous person, use personId", details: { candidates: [] } },
    };
    const error = await createApi(config, fakeFetch(409, body))
      .post("/todos", {})
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "conflict", message: "ambiguous person, use personId" });
    expect((error as ApiError).details).toEqual({ candidates: [] });
  });

  it("explains a rejected token without echoing it", async () => {
    const body = { error: { code: "unauthorized", message: "bad token" } };
    const error = (await createApi(config, fakeFetch(401, body))
      .get("/me")
      .catch((e: unknown) => e)) as Error;
    expect(error.message).toContain(`The token in ${tokenFile} was not accepted`);
    expect(error.message).not.toContain(TOKEN);
  });

  it("says when the answer is not from Sloppanizer", async () => {
    await expect(createApi(config, fakeFetch(502, undefined)).get("/stats")).rejects.toThrow(
      "answered 502 without a Sloppanizer error body",
    );
  });

  it("returns undefined for 204", async () => {
    await expect(createApi(config, fakeFetch(204, undefined)).patch("/x", {})).resolves.toBeUndefined();
  });

  it("explains a missing or malformed token file", async () => {
    const missing = createApi({ ...config, tokenFile: join(dir, "nope") }, fakeFetch(200, {}));
    await expect(missing.get("/me")).rejects.toThrow(/No API token at .*nope\. Create one in Sloppanizer/);
    const badFile = join(dir, "bad");
    writeFileSync(badFile, "hello");
    const bad = createApi({ ...config, tokenFile: badFile }, fakeFetch(200, {}));
    await expect(bad.get("/me")).rejects.toThrow(ToolError);
    await expect(bad.get("/me")).rejects.toThrow("does not hold a Sloppanizer token");
  });
});
