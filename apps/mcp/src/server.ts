import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import packageJson from "../package.json" with { type: "json" };
import { createApi } from "./api.ts";
import type { McpConfig } from "./config.ts";
import { registerTools } from "./tools.ts";

export function createServer(config: McpConfig, fetchImpl?: typeof fetch): McpServer {
  const server = new McpServer(
    { name: "organizer", version: packageJson.version },
    {
      instructions:
        "organizer holds the user's todos and notes. Todos are shown as #id. Priorities are scoped labels " +
        "priority::critical|high|medium|low. Start with overview or next_up when helping the user plan.",
    },
  );
  registerTools(server, { api: createApi(config, fetchImpl), timeZone: config.timeZone });
  return server;
}
