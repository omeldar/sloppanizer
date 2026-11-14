import { homedir } from "node:os";
import { join } from "node:path";
import { isValidTimeZone, systemTimeZone } from "@organizer/shared";

export interface McpConfig {
  /** Base URL of the Sloppanizer API, without a trailing slash. */
  url: string;
  /** File holding the account's API token. Read on every call, never logged. */
  tokenFile: string;
  /** The token itself, when the server is hosted in the API for the caller; then tokenFile is not read. */
  token?: string;
  /** Zone for "today", overdue and age in the text output. */
  timeZone: string;
}

export const DEFAULT_URL = "http://127.0.0.1:4711";

/**
 * Reads the config from the environment. The token itself never comes from the environment. One MCP
 * server entry per account: each entry points at its own token file.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const zone = env.SLOPPANIZER_TZ || systemTimeZone();
  return {
    url: (env.SLOPPANIZER_URL || DEFAULT_URL).replace(/\/+$/, ""),
    tokenFile: env.SLOPPANIZER_TOKEN_FILE || join(homedir(), ".config", "sloppanizer", "mcp-token"),
    timeZone: isValidTimeZone(zone) ? zone : "UTC",
  };
}
