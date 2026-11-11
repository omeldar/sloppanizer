// Placeholder entry; the MCP builder replaces it.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatDuration } from "@organizer/shared";

const server = new McpServer({ name: "organizer", version: "0.1.0" });
console.error(`organizer MCP placeholder ${server ? "ready" : ""} (${formatDuration(0)})`);
