import { homedir } from "node:os";
import { join } from "node:path";
import { isValidTimeZone, systemTimeZone } from "@organizer/shared";

export interface McpConfig {
  /** Base URL of the organizer server, without a trailing slash. */
  url: string;
  /** File holding the API token (written by the install step). Read on every call, never logged. */
  tokenFile: string;
  /** Zone for "today", overdue and age in the text output. */
  timeZone: string;
  /** WSL distribution name (WSL_DISTRO_NAME), to show Windows paths of files; undefined outside WSL. */
  wslDistro?: string | undefined;
}

export const DEFAULT_URL = "http://127.0.0.1:4711";
export const TOKEN_FILE_NAME = "mcp-token";

/** Reads the config from the environment. The token itself never comes from the environment. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const dataDir = env.ORGANIZER_DATA_DIR || join(homedir(), ".local", "share", "organizer");
  const zone = env.ORGANIZER_TZ || systemTimeZone();
  return {
    url: (env.ORGANIZER_URL || DEFAULT_URL).replace(/\/+$/, ""),
    tokenFile: env.ORGANIZER_TOKEN_FILE || join(dataDir, TOKEN_FILE_NAME),
    timeZone: isValidTimeZone(zone) ? zone : "UTC",
    wslDistro: env.WSL_DISTRO_NAME || undefined,
  };
}
