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
        "priority::critical|high|medium|low. Start with overview or next_up when helping the user plan. " +
        "People are a small directory of colleagues: list_people with a topic or team answers whom to ask, " +
        "and contacts on a todo record whom to ask about it. Each todo has a thread (get_activity, add_comment). " +
        "Todos can have subtasks, a Markdown checklist (check_item), links (blocks, relates to) and a repeat rule; " +
        "people_stats shows who asks for how much and how fast it gets done.",
    },
  );
  registerTools(server, {
    api: createApi(config, fetchImpl),
    timeZone: config.timeZone,
    wslDistro: config.wslDistro,
  });
  return server;
}
