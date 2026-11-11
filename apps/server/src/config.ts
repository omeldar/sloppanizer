import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidTimeZone, systemTimeZone } from "@organizer/shared";

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  /** Lowercase host names (no port) the server answers to. */
  allowedHosts: string[];
  timeZone: string;
  /** Built web app (index.html and assets). */
  webDir: string;
  production: boolean;
}

const DEFAULT_ALLOWED_HOSTS = "organizer.localhost,localhost,127.0.0.1,[::1]";

/** Where the web build sits next to this package in the checkout (apps/web/dist). */
const DEFAULT_WEB_DIR = fileURLToPath(new URL("../../web/dist", import.meta.url));

export class ConfigError extends Error {}

/** Reads the runtime config from the environment. Every value is optional. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.ORGANIZER_PORT ?? 4711);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`ORGANIZER_PORT must be a port number (1..65535), got "${env.ORGANIZER_PORT}".`);
  }
  const timeZone = env.ORGANIZER_TZ || systemTimeZone();
  if (!isValidTimeZone(timeZone)) {
    throw new ConfigError(
      `ORGANIZER_TZ is not a known time zone: "${timeZone}". Use a name like Europe/Zurich.`,
    );
  }
  const allowedHosts = (env.ORGANIZER_ALLOWED_HOSTS ?? DEFAULT_ALLOWED_HOSTS)
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0);
  if (allowedHosts.length === 0)
    throw new ConfigError("ORGANIZER_ALLOWED_HOSTS must list at least one host name.");
  return {
    port,
    host: env.ORGANIZER_HOST || "127.0.0.1",
    dataDir: resolve(env.ORGANIZER_DATA_DIR || join(homedir(), ".local", "share", "organizer")),
    allowedHosts,
    timeZone,
    webDir: resolve(env.ORGANIZER_WEB_DIR || DEFAULT_WEB_DIR),
    production: env.NODE_ENV === "production",
  };
}
