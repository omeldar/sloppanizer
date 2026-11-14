import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "@organizer/mcp/server";
import type { InjectOptions } from "fastify";
import { authOf, ctxOf, type App, type Deps } from "./types.ts";

/** Base of the API URLs the MCP tools build; only the path reaches the app (app.inject). */
const INTERNAL_URL = "http://sloppanizer.internal";

/**
 * The MCP server of the hosted API (Streamable HTTP, stateless, JSON answers). Every request gets its
 * own MCP server whose tools call the REST API in-process with the caller's bearer value, so auth,
 * scope (a read token can only read), account isolation and rate limits are those of the REST routes.
 */
export function mcpRoutes(app: App, deps: Deps): void {
  app.post("/api/v1/mcp", { schema: { hide: true }, config: { access: "any" } }, async (request, reply) => {
    authOf(request);
    // The security hook accepted this header, so it is a valid bearer value.
    const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "")?.[1] ?? "";
    const host = request.headers.host ?? "";

    const inProcess: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const res = await app.inject({
        method: (init?.method ?? "GET") as InjectOptions["method"],
        url: `${url.pathname}${url.search}`,
        headers: { ...(init?.headers as Record<string, string>), host },
        remoteAddress: request.ip,
        ...(typeof init?.body === "string" ? { payload: init.body } : {}),
      });
      const headers = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
      }
      return new Response(res.statusCode === 204 ? null : res.rawPayload, {
        status: res.statusCode,
        headers,
      });
    };

    const server = createServer(
      { url: INTERNAL_URL, tokenFile: "", token: bearer, timeZone: ctxOf(request, deps).timeZone },
      inProcess,
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined && name !== "content-length")
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const res = await transport.handleRequest(
        new Request(`${INTERNAL_URL}${request.url}`, { method: "POST", headers }),
        { parsedBody: request.body },
      );
      reply.status(res.status);
      res.headers.forEach((value, name) => reply.header(name, value));
      const body = await res.text();
      return reply.send(body === "" ? undefined : body);
    } finally {
      await server.close();
    }
  });

  // Stateless: no server-sent event stream to open and no session to end.
  for (const method of ["GET", "DELETE"] as const) {
    app.route({
      method,
      url: "/api/v1/mcp",
      schema: { hide: true },
      config: { access: "any" },
      handler: async (_request, reply) => reply.status(405).header("allow", "POST").send(),
    });
  }
}
