import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, proxyMatcher } from "../src/config.ts";

const KEY = Buffer.alloc(32, 9).toString("base64");
const prod = {
  NODE_ENV: "production",
  SLOPPANIZER_DATA_KEY: KEY,
  SLOPPANIZER_WEB_ORIGINS: "https://organizer.omeldar.com",
  SLOPPANIZER_RP_ID: "organizer.omeldar.com",
};

/** The ConfigError message for an env, or a marker when it loads (or fails another way). */
function configError(env: Record<string, string>): string {
  try {
    loadConfig(env);
    return "(loaded)";
  } catch (error) {
    return error instanceof ConfigError ? error.message : `(not a ConfigError: ${String(error)})`;
  }
}

describe("config", () => {
  it("has development defaults that need no env at all", () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      port: 4711,
      host: "127.0.0.1",
      webOrigins: ["http://localhost:5181"],
      rpId: "localhost",
      rpName: "Sloppanizer",
      allowedHosts: ["organizerapi.omeldar.cloud", "localhost", "127.0.0.1"],
      trustedProxies: [],
      dataKey: null,
      setupCode: null,
      signupsOpen: true,
      timeZone: "UTC",
      backupAt: "03:30",
      backupKeep: 7,
      filesLimitBytes: 2048 * 1024 * 1024,
      webDir: null,
      production: false,
    });
    expect(config.dataDir).toMatch(/\.local\/share\/sloppanizer$/);
    expect(config.filesDir).toBe(`${config.dataDir}/files`);
    expect(config.backupDir).toBe(`${config.dataDir}/backups`);
  });

  it("reads the production setup", () => {
    const config = loadConfig({
      ...prod,
      SLOPPANIZER_TRUSTED_PROXIES: "172.16.0.0/12",
      SLOPPANIZER_SETUP_CODE: "abcd-efgh-ijkl-mnop-qrst",
      SLOPPANIZER_SIGNUPS: "closed",
      SLOPPANIZER_BACKUP_AT: "",
      SLOPPANIZER_PUBLIC_URL: "https://organizerapi.omeldar.cloud",
    });
    expect(config.dataKey?.length).toBe(32);
    expect(config.setupCode).toBe("ABCDEFGHIJKLMNOPQRST");
    expect(config.signupsOpen).toBe(false);
    expect(config.backupAt).toBeNull();
    expect(config.publicUrl).toBe("https://organizerapi.omeldar.cloud");
  });

  it("refuses production without a data key or with an http origin", () => {
    expect(configError({ ...prod, SLOPPANIZER_DATA_KEY: "" })).toMatch(
      /SLOPPANIZER_DATA_KEY is required in production/,
    );
    expect(configError({ ...prod, SLOPPANIZER_WEB_ORIGINS: "http://organizer.omeldar.com" })).toMatch(
      /must use https/,
    );
    expect(configError({ ...prod, SLOPPANIZER_DATA_KEY: "too-short" })).toMatch(/32 bytes in base64/);
  });

  it("refuses an RP ID that does not fit every web origin", () => {
    expect(configError({ ...prod, SLOPPANIZER_RP_ID: "omeldar.cloud" })).toMatch(
      /does not fit the web origin/,
    );
    expect(loadConfig({ ...prod, SLOPPANIZER_RP_ID: "omeldar.com" }).rpId).toBe("omeldar.com");
    // A suffix that is not a parent domain does not count.
    expect(configError({ ...prod, SLOPPANIZER_RP_ID: "ldar.com" })).toMatch(/does not fit/);
  });

  it("refuses origins with paths and other schemes", () => {
    expect(configError({ SLOPPANIZER_WEB_ORIGINS: "https://a.example/app" })).toMatch(/origin only/);
    expect(configError({ SLOPPANIZER_WEB_ORIGINS: "ftp://a.example" })).toMatch(/must start with https/);
    expect(configError({ SLOPPANIZER_WEB_ORIGINS: "not a url" })).toMatch(/is not a URL/);
  });

  it("refuses bad CIDRs, numbers, times, codes and switches with a plain message", () => {
    expect(configError({ SLOPPANIZER_TRUSTED_PROXIES: "172.16.0.0/40" })).toMatch(/prefix length/);
    expect(configError({ SLOPPANIZER_TRUSTED_PROXIES: "caddy" })).toMatch(/not an IP address/);
    expect(configError({ SLOPPANIZER_PORT: "70000" })).toMatch(/SLOPPANIZER_PORT must be a whole number/);
    expect(configError({ SLOPPANIZER_BACKUP_AT: "3:30" })).toMatch(/HH:MM/);
    expect(configError({ SLOPPANIZER_SETUP_CODE: "short" })).toMatch(/20 to 64/);
    expect(configError({ SLOPPANIZER_SIGNUPS: "maybe" })).toMatch(/open" or "closed/);
    expect(configError({ SLOPPANIZER_DEFAULT_TZ: "Mars/Olympus" })).toMatch(/time zone/);
    expect(configError({ SLOPPANIZER_SECRET: "short" })).toMatch(/at least 32/);
  });

  it("reads the day the own login ends, in the default time zone, only with SLOPPANIZER_AUTH=both", () => {
    const env = { SLOPPANIZER_LOCAL_LOGIN_UNTIL: "2026-12-25", SLOPPANIZER_DEFAULT_TZ: "Europe/Zurich" };
    expect(loadConfig({ ...env, SLOPPANIZER_AUTH: "both" }).omeldar.localLoginEnds).toEqual({
      on: "2026-12-25",
      at: new Date("2026-12-24T23:00:00.000Z"),
    });
    expect(loadConfig({ ...env, SLOPPANIZER_AUTH: "local" }).omeldar.localLoginEnds).toBeNull();
    expect(loadConfig({ SLOPPANIZER_AUTH: "both" }).omeldar.localLoginEnds).toBeNull();
    for (const bad of ["25.12.2026", "2026-02-30", "tomorrow"]) {
      expect(configError({ SLOPPANIZER_LOCAL_LOGIN_UNTIL: bad })).toBe(
        `SLOPPANIZER_LOCAL_LOGIN_UNTIL must be a date like 2026-12-31 (the day the own login stops), got "${bad}".`,
      );
    }
  });

  it("matches trusted proxies by CIDR, also IPv4-mapped IPv6 addresses", () => {
    const trusted = proxyMatcher(["172.16.0.0/12", "fd00::/8"]);
    expect(trusted("172.18.0.5")).toBe(true);
    expect(trusted("::ffff:172.18.0.5")).toBe(true);
    expect(trusted("192.168.1.1")).toBe(false);
    expect(trusted("fd12::1")).toBe(true);
    expect(trusted("not-an-ip")).toBe(false);
    expect(proxyMatcher([])("172.18.0.5")).toBe(false);
  });
});
