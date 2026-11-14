import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { makeApp, type TestApp } from "./helpers.ts";

interface RpcResult {
  result?: { content?: { type: string; text: string }[]; isError?: boolean; tools?: { name: string }[] };
  error?: { code: number; message: string };
}

let nextId = 1;

/** One JSON-RPC message to the MCP endpoint, as an MCP client sends it. */
function rpc(
  t: TestApp,
  raw: string | null,
  method: string,
  params: unknown = {},
): Promise<LightMyRequestResponse> {
  return t.app.inject({
    method: "POST",
    url: "/api/v1/mcp",
    headers: {
      ...(raw === null ? {} : { authorization: `Bearer ${raw}` }),
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    payload: { jsonrpc: "2.0", id: nextId++, method, params },
  });
}

async function callTool(t: TestApp, raw: string, name: string, args: Record<string, unknown> = {}) {
  const res = await rpc(t, raw, "tools/call", { name, arguments: args });
  expect(res.statusCode).toBe(200);
  const body = res.json() as RpcResult;
  return { text: body.result?.content?.map((c) => c.text).join("\n") ?? "", isError: body.result?.isError };
}

describe("hosted MCP endpoint", () => {
  it("initializes and lists the tools for a token", async () => {
    const t = await makeApp();
    const raw = t.token("assistant", "write");
    const init = await rpc(t, raw, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(init.statusCode).toBe(200);
    expect(JSON.stringify(init.json())).toContain("sloppanizer");
    const list = (await rpc(t, raw, "tools/list")).json() as RpcResult;
    const names = list.result?.tools?.map((tool) => tool.name) ?? [];
    expect(names).toContain("create_todo");
    expect(names).toContain("overview");
  });

  it("acts on the caller's account through the REST API", async () => {
    const t = await makeApp();
    const raw = t.token("assistant", "write");
    const created = await callTool(t, raw, "create_todo", { title: "Call the plumber" });
    expect(created.isError).toBeFalsy();
    const todos = (await t.call("GET", "/api/v1/todos")).json() as { items: { title: string }[] };
    expect(JSON.stringify(todos)).toContain("Call the plumber");
    expect((await callTool(t, raw, "list_todos")).text).toContain("Call the plumber");
  });

  it("keeps accounts apart", async () => {
    const t = await makeApp();
    await t.create("/api/v1/todos", { title: "Anna's secret" });
    const bo = await t.asAccount({ username: "bo" });
    const boToken = bo.token("assistant", "write");
    expect((await callTool(t, boToken, "list_todos")).text).not.toContain("Anna's secret");
    expect((await callTool(t, boToken, "search", { query: "secret" })).text).not.toContain("Anna's secret");
  });

  it("lets a read token read but not change anything", async () => {
    const t = await makeApp();
    await t.create("/api/v1/todos", { title: "Readable" });
    const raw = t.token("reader", "read");
    expect((await callTool(t, raw, "list_todos")).text).toContain("Readable");
    const write = await callTool(t, raw, "create_todo", { title: "Nope" });
    expect(write.isError).toBe(true);
    expect(write.text).toContain("can only read");
    expect(JSON.stringify((await t.call("GET", "/api/v1/todos")).json())).not.toContain("Nope");
  });

  it("answers 401 without a valid token and 405 to GET", async () => {
    const t = await makeApp();
    expect((await rpc(t, null, "tools/list")).statusCode).toBe(401);
    expect((await rpc(t, `spz_${"a".repeat(40)}`, "tools/list")).statusCode).toBe(401);
    const raw = t.token("assistant", "read");
    expect((await t.withToken(raw, "GET", "/api/v1/mcp")).statusCode).toBe(405);
  });
});
