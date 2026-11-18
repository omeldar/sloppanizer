import { Health, versionGap, type VersionGap } from "@organizer/shared";
import { useSyncExternalStore } from "react";
import pkg from "../../package.json" with { type: "json" };
import { ApiError } from "./apiError.ts";
import { apiUrl } from "./config.ts";

/**
 * The web app's release against the server's. At a release Vercel serves the new web app within minutes,
 * while the server only updates when Watchtower pulls the new image (up to 5 minutes later). Meanwhile
 * new features fail on the old server; the banner says so, and their errors read "in a few minutes".
 */

export const WEB_VERSION: string = pkg.version;
export const WEB_COMMIT: string = __APP_COMMIT__;

/**
 * The lowest server version this web app works with. Leave it null: then any server of the same minor
 * release works (web 1.4.2 with server 1.4.0). Set it when a fix release of the web app needs that same
 * release on the server too, e.g. "1.4.2".
 */
export const MIN_SERVER_VERSION: string | null = null;

export const UPDATING_MESSAGE =
  "This is not available yet: Sloppanizer is updating. It works again in a few minutes, no reload needed.";

let serverVersion: string | null = null;
const listeners = new Set<() => void>();
let checkNow: (() => void) | null = null;

/** Records the version the server reported (null: not known). */
export function setServerVersion(version: string | null): void {
  if (version === serverVersion) return;
  serverVersion = version;
  for (const listener of listeners) listener();
}

export function versionGapNow(): VersionGap {
  return serverVersion === null ? "unknown" : versionGap(WEB_VERSION, serverVersion, MIN_SERVER_VERSION);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useVersionGap(): VersionGap {
  return useSyncExternalStore(subscribe, versionGapNow, versionGapNow);
}

/** The version check registers how to run at once (an answer hinted the server may be older). */
export function setVersionCheck(run: (() => void) | null): void {
  checkNow = run;
}

/** The server's release version from the public health route. */
export async function fetchServerVersion(): Promise<string> {
  const response = await fetch(apiUrl("/health"), {
    credentials: "omit",
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Health check answered ${response.status}.`);
  return Health.parse(await response.json()).version;
}

/** The server's answer to a route it does not have (apps/server/src/http/web.ts unknownRouteBody). */
const UNKNOWN_ROUTE = /^[A-Z]+ \S+ does not exist\. See \/api\/docs/;

/** Whether a failure is what an older server answers to something only a newer release has. */
function looksLikeOlderServer(error: ApiError): boolean {
  if (error.code === "bad_response") return true;
  if (error.status === 404 && error.code === "not_found") return UNKNOWN_ROUTE.test(error.message);
  if (error.status === 422 && error.code === "validation_failed") {
    // A field the old contract does not know yet (zod strict objects).
    return /Unrecognized key/i.test(error.message);
  }
  return false;
}

/**
 * While the server is being updated, an error that comes from the older server not knowing a new feature
 * says so plainly instead of "does not exist". Any other error stays as it is.
 */
export function duringUpdate(error: ApiError): ApiError {
  if (!looksLikeOlderServer(error)) return error;
  if (versionGapNow() === "server-older") {
    return new ApiError(error.status, error.code, UPDATING_MESSAGE, error.details);
  }
  // Not known yet (or a long-open tab): check now, the banner follows if it is an update.
  checkNow?.();
  return error;
}
