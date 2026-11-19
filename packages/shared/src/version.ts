/**
 * Release versions (`major.minor.patch`, from the root package.json; `pnpm release` sets them). The web
 * app and the server image of one release carry the same version. At a release the web app is usually
 * live a few minutes before the server, so the two compare versions to tell the user what is going on.
 */

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

const PATTERN = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+][0-9A-Za-z.-]*)?$/;

/** The version in `text` ("1.4.0", "v1.4.0", "1.4.0-rc.1"), or null when it is not one. */
export function parseVersion(text: string): Version | null {
  const match = PATTERN.exec(text.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** Negative when a is older than b, 0 when equal, positive when newer. Pre-release tags are ignored. */
export function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export const formatVersion = (v: Version): string => `${v.major}.${v.minor}.${v.patch}`;

/**
 * - "same": nothing to say.
 * - "server-older": the server is still on a release this web app does not work with yet (it is being
 *   updated); features of the new release may fail for a few minutes.
 * - "web-older": the server runs a newer release than this page (an old open tab); a reload brings it.
 * - "unknown": a version could not be read; say nothing.
 */
export type VersionGap = "same" | "server-older" | "web-older" | "unknown";

/**
 * Compares the web app's version with the server's. The web app needs a server of its own minor
 * release (`1.4.x` for web `1.4.2`), or `minServer` when it declares a higher one: a fix release of only
 * one side then never counts as "server-older". Any newer server counts as "web-older".
 */
export function versionGap(web: string, server: string, minServer?: string | null): VersionGap {
  const w = parseVersion(web);
  const s = parseVersion(server);
  if (!w || !s) return "unknown";
  if (compareVersions(s, w) > 0) return "web-older";
  const ownMinor: Version = { major: w.major, minor: w.minor, patch: 0 };
  const declared = minServer ? parseVersion(minServer) : null;
  const needed = declared && compareVersions(declared, ownMinor) > 0 ? declared : ownMinor;
  return compareVersions(s, needed) < 0 ? "server-older" : "same";
}
