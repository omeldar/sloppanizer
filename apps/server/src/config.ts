import {
  type AuthMode,
  isCalendarDate,
  isValidTimeZone,
  normalizeOneTimeCode,
  startOfLocalDay,
} from "@organizer/shared";
import { BlockList, isIP } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DataKeyError, parseDataKey } from "./services/auth/crypto.ts";

export interface Config {
  port: number;
  host: string;
  /** DB, secret, data key file (development), staged restores. */
  dataDir: string;
  /** Attachments, one folder per account. */
  filesDir: string;
  /** Instance backups and per-account restore safety copies. */
  backupDir: string;
  /** Web app origins (scheme://host[:port]): CORS, the Origin check and WebAuthn origins. */
  webOrigins: string[];
  /** WebAuthn relying party id: the web origins' host or a parent domain of it. */
  rpId: string;
  rpName: string;
  /** The API's own origin (OpenAPI servers, the docs page's Origin), or null. */
  publicUrl: string | null;
  /** Lowercase host names (no port) the server answers to. */
  allowedHosts: string[];
  /** CIDRs whose X-Forwarded-For and X-Forwarded-Proto are trusted. Empty: nobody. */
  trustedProxies: string[];
  /** 32 bytes from SLOPPANIZER_DATA_KEY; null in development (a file in the data dir is used). */
  dataKey: Buffer | null;
  /** SLOPPANIZER_SECRET; null: the `secret` file in the data dir. */
  secret: string | null;
  /** Fixed first-admin setup code; null: a new one is printed at each start until an admin exists. */
  setupCode: string | null;
  signupsOpen: boolean;
  /** Backup schedule and fallback zone for broken account data. */
  timeZone: string;
  /** "HH:MM" in timeZone, or null (no daily backup). */
  backupAt: string | null;
  backupKeep: number;
  filesLimitBytes: number;
  /** Built web app for the local web mode (one origin), or null (API only). */
  webDir: string | null;
  /** Sign-in through auth.omeldar.com (OpenID Connect); see SLOPPANIZER_AUTH. */
  omeldar: {
    mode: AuthMode;
    issuer: string;
    clientId: string;
    /** Null: a public client (local auth without a secret for this app). */
    clientSecret: string | null;
    /** The web app's callback page, registered at auth (matched exactly). */
    redirectUri: string;
    /**
     * SLOPPANIZER_LOCAL_LOGIN_UNTIL: the day Sloppanizer's own login stops working (from 00:00 that day in
     * SLOPPANIZER_DEFAULT_TZ), with `at` that instant. Only counts with SLOPPANIZER_AUTH=both; null: no end.
     */
    localLoginEnds: { on: string; at: Date } | null;
  };
  production: boolean;
}

export class ConfigError extends Error {}

/** The setup code from the env, normalized like a typed one, or null when it is not 20..64 letters and digits. */
function normalizeSetupCodeEnv(value: string): string | null {
  const code = normalizeOneTimeCode(value);
  return /^[A-Z0-9]{20,64}$/.test(code) ? code : null;
}

const DEFAULT_ALLOWED_HOSTS = "organizerapi.omeldar.cloud,localhost,127.0.0.1";
const DEFAULT_WEB_ORIGINS = "http://localhost:5181";

type Env = NodeJS.ProcessEnv;

const list = (value: string): string[] =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be a whole number from ${min} to ${max}, got "${raw}".`);
  }
  return value;
}

/** "https://app.example.com" from a URL; refuses paths, queries and other schemes. */
function origin(name: string, value: string, production: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name}: "${value}" is not a URL. Use e.g. https://organizer.example.com.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(`${name}: "${value}" must start with https:// (or http:// in development).`);
  }
  if (production && url.protocol !== "https:") {
    throw new ConfigError(`${name}: "${value}" must use https:// in production.`);
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash || url.username) {
    throw new ConfigError(`${name}: "${value}" must be an origin only, without a path.`);
  }
  return url.origin;
}

/** Whether a CIDR (or single address) is well formed. */
export function parseCidr(value: string): { address: string; prefix: number; family: "ipv4" | "ipv6" } {
  const [address = "", prefixText, extra] = value.split("/");
  const version = isIP(address);
  if (version === 0 || extra !== undefined) throw new ConfigError(`"${value}" is not an IP address or CIDR.`);
  const max = version === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? max : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max || prefixText === "") {
    throw new ConfigError(`"${value}" has a prefix length outside 0..${max}.`);
  }
  return { address, prefix, family: version === 4 ? "ipv4" : "ipv6" };
}

/** A matcher for the trusted proxy list (IPv4-mapped IPv6 addresses match their IPv4 rules). */
export function proxyMatcher(cidrs: readonly string[]): (address: string) => boolean {
  const blocks = new BlockList();
  for (const cidr of cidrs) {
    const { address, prefix, family } = parseCidr(cidr);
    blocks.addSubnet(address, prefix, family);
  }
  return (address: string) => {
    const plain = address.startsWith("::ffff:") && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
    const version = isIP(plain);
    if (version === 0) return false;
    return blocks.check(plain, version === 4 ? "ipv4" : "ipv6");
  };
}

/** Whether the RP ID equals the host or is a parent domain of it. */
const fitsRpId = (host: string, rpId: string): boolean => host === rpId || host.endsWith(`.${rpId}`);

/** Reads and checks the runtime config from the environment. */
export function loadConfig(env: Env = process.env): Config {
  const production = env.NODE_ENV === "production";
  const port = integer(env, "SLOPPANIZER_PORT", 4711, 1, 65535);

  const timeZone = env.SLOPPANIZER_DEFAULT_TZ || "UTC";
  if (!isValidTimeZone(timeZone)) {
    throw new ConfigError(
      `SLOPPANIZER_DEFAULT_TZ is not a known time zone: "${timeZone}". Use a name like Europe/Zurich.`,
    );
  }

  const allowedHosts = list(env.SLOPPANIZER_ALLOWED_HOSTS ?? DEFAULT_ALLOWED_HOSTS).map((h) =>
    h.toLowerCase(),
  );
  if (allowedHosts.length === 0)
    throw new ConfigError("SLOPPANIZER_ALLOWED_HOSTS must list at least one host name.");

  const webOrigins = list(env.SLOPPANIZER_WEB_ORIGINS ?? DEFAULT_WEB_ORIGINS).map((value) =>
    origin("SLOPPANIZER_WEB_ORIGINS", value, production),
  );
  if (webOrigins.length === 0)
    throw new ConfigError("SLOPPANIZER_WEB_ORIGINS must list at least one origin.");

  const rpId = (env.SLOPPANIZER_RP_ID || "localhost").toLowerCase();
  for (const value of webOrigins) {
    const host = new URL(value).hostname;
    if (!fitsRpId(host, rpId)) {
      throw new ConfigError(
        `SLOPPANIZER_RP_ID "${rpId}" does not fit the web origin ${value}: it must be its host name or a parent domain.`,
      );
    }
  }

  const publicUrl = env.SLOPPANIZER_PUBLIC_URL
    ? origin("SLOPPANIZER_PUBLIC_URL", env.SLOPPANIZER_PUBLIC_URL, production)
    : null;

  const trustedProxies = list(env.SLOPPANIZER_TRUSTED_PROXIES ?? "");
  for (const cidr of trustedProxies) {
    try {
      parseCidr(cidr);
    } catch (error) {
      throw new ConfigError(`SLOPPANIZER_TRUSTED_PROXIES: ${(error as Error).message}`);
    }
  }

  let dataKey: Buffer | null = null;
  if (env.SLOPPANIZER_DATA_KEY) {
    try {
      dataKey = parseDataKey(env.SLOPPANIZER_DATA_KEY);
    } catch (error) {
      if (error instanceof DataKeyError) throw new ConfigError(error.message);
      throw error;
    }
  } else if (production) {
    throw new ConfigError(
      "SLOPPANIZER_DATA_KEY is required in production (32 bytes in base64: openssl rand -base64 32). " +
        "Keep a copy in a password manager: without it every authenticator has to be reset.",
    );
  }

  const secret = env.SLOPPANIZER_SECRET || null;
  if (secret !== null && secret.length < 32) {
    throw new ConfigError("SLOPPANIZER_SECRET must be at least 32 characters (openssl rand -hex 32).");
  }

  let setupCode: string | null = null;
  if (env.SLOPPANIZER_SETUP_CODE) {
    setupCode = normalizeSetupCodeEnv(env.SLOPPANIZER_SETUP_CODE);
    if (setupCode === null) {
      throw new ConfigError(
        "SLOPPANIZER_SETUP_CODE must have 20 to 64 letters and digits (dashes and spaces are ignored).",
      );
    }
  }

  const signups = env.SLOPPANIZER_SIGNUPS || "open";
  if (signups !== "open" && signups !== "closed") {
    throw new ConfigError(`SLOPPANIZER_SIGNUPS must be "open" or "closed", got "${signups}".`);
  }

  const backupAtRaw = env.SLOPPANIZER_BACKUP_AT ?? "03:30";
  let backupAt: string | null = null;
  if (backupAtRaw.trim() !== "") {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(backupAtRaw.trim());
    if (!match)
      throw new ConfigError(`SLOPPANIZER_BACKUP_AT must be HH:MM (24 h) or empty, got "${backupAtRaw}".`);
    backupAt = backupAtRaw.trim();
  }

  const mode = (env.SLOPPANIZER_AUTH || "local") as AuthMode;
  if (mode !== "local" && mode !== "both" && mode !== "oidc") {
    throw new ConfigError(`SLOPPANIZER_AUTH must be "local", "both" or "oidc", got "${mode}".`);
  }
  const issuer = origin(
    "SLOPPANIZER_AUTH_ISSUER",
    env.SLOPPANIZER_AUTH_ISSUER || "https://auth.omeldar.com",
    production,
  );
  const clientSecret = env.SLOPPANIZER_AUTH_CLIENT_SECRET || null;
  if (production && mode !== "local" && clientSecret === null) {
    throw new ConfigError(
      "SLOPPANIZER_AUTH_CLIENT_SECRET is required with SLOPPANIZER_AUTH=both or oidc (the same value as AUTH_CLIENT_SECRET_SLOPPANIZER at auth).",
    );
  }
  const redirectUri =
    env.SLOPPANIZER_AUTH_REDIRECT_URI || `${webOrigins[0] ?? "http://localhost:5181"}/auth/callback`;
  if (!URL.canParse(redirectUri)) {
    throw new ConfigError(`SLOPPANIZER_AUTH_REDIRECT_URI must be a full URL, got "${redirectUri}".`);
  }

  const untilRaw = (env.SLOPPANIZER_LOCAL_LOGIN_UNTIL ?? "").trim();
  if (untilRaw !== "" && !(/^\d{4}-\d{2}-\d{2}$/.test(untilRaw) && isCalendarDate(untilRaw))) {
    throw new ConfigError(
      `SLOPPANIZER_LOCAL_LOGIN_UNTIL must be a date like 2026-12-31 (the day the own login stops), got "${untilRaw}".`,
    );
  }
  // With "local" there is nothing to sign in with instead, with "oidc" the own login is already off.
  const localLoginEnds =
    untilRaw !== "" && mode === "both" ? { on: untilRaw, at: startOfLocalDay(untilRaw, timeZone) } : null;

  const dataDir = resolve(env.SLOPPANIZER_DATA_DIR || join(homedir(), ".local", "share", "sloppanizer"));
  return {
    port,
    host: env.SLOPPANIZER_HOST || "127.0.0.1",
    dataDir,
    filesDir: resolve(env.SLOPPANIZER_FILES_DIR || join(dataDir, "files")),
    backupDir: resolve(env.SLOPPANIZER_BACKUP_DIR || join(dataDir, "backups")),
    webOrigins,
    rpId,
    rpName: env.SLOPPANIZER_RP_NAME || "Sloppanizer",
    publicUrl,
    allowedHosts,
    trustedProxies,
    dataKey,
    secret,
    setupCode,
    signupsOpen: signups === "open",
    timeZone,
    backupAt,
    backupKeep: integer(env, "SLOPPANIZER_BACKUP_KEEP", 7, 1, 365),
    filesLimitBytes: integer(env, "SLOPPANIZER_FILES_LIMIT_MB", 1024, 1, 1_048_576) * 1024 * 1024,
    webDir: env.SLOPPANIZER_WEB_DIR ? resolve(env.SLOPPANIZER_WEB_DIR) : null,
    production,
    omeldar: {
      mode,
      issuer,
      clientId: env.SLOPPANIZER_AUTH_CLIENT_ID || "sloppanizer",
      clientSecret,
      redirectUri,
      localLoginEnds,
    },
  };
}
