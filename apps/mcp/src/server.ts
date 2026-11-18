import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import packageJson from "../package.json" with { type: "json" };
import { createApi } from "./api.ts";
import type { McpConfig } from "./config.ts";
import { registerTools } from "./tools.ts";

export function createServer(config: McpConfig, fetchImpl?: typeof fetch): McpServer {
  const server = new McpServer(
    { name: "sloppanizer", version: packageJson.version },
    {
      instructions:
        "Sloppanizer holds the todos and notes of one account of the user. Todos are shown as #id. Priorities are scoped labels " +
        "priority::critical|high|medium|low. Start with overview or next_up when helping the user plan. " +
        "People are a small directory of colleagues: list_people with a topic or team answers whom to ask, " +
        "and contacts on a todo record whom to ask about it. Each todo has a thread (get_activity, add_comment). " +
        "Todos can have subtasks, a Markdown checklist (check_item), links (blocks, relates to) and a repeat rule; " +
        "people_stats shows who asks for how much and how fast it gets done. Todos keep web links (add_web_link). " +
        "The planner holds time blocks in the user's local time: list_plan shows them and the meeting dates, plan_time reserves time for a todo. " +
        "Meetings repeat; a standup has a list of what the user has not said yet (standup_list), ticked with mark_said; " +
        "meeting_note writes into the note of a meeting date. Todos can be added to any meeting by hand (add_to_meeting, " +
        "meeting_todos, remove_from_meeting); they stay on every date until removed. " +
        "Replies write dates as dd.MM.yyyy (03.10.2026); tool inputs take dates as YYYY-MM-DD (2026-10-03).",
    },
  );
  registerTools(server, {
    api: createApi(config, fetchImpl),
    timeZone: config.timeZone,
  });
  return server;
}
