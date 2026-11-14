/**
 * Security headers for the web app's HTML, in one place: apps/web/vercel.json (hosted) and the server's
 * local web mode both send exactly these, and a test in apps/web keeps vercel.json in line.
 */

export interface WebHeaderOptions {
  /**
   * Origin of the API when it is not the page's own origin (hosted: the API lives on another site).
   * null = same origin (`pnpm dev` through the Vite proxy, the server's local web mode).
   */
  apiOrigin: string | null;
}

/** Paths of the app entry (app.html); everything else is the landing page, a static file or 404. */
export const APP_PATH_PREFIXES = [
  "/u/",
  "/login",
  "/signup",
  "/setup",
  "/reset",
  "/oauth/authorize",
] as const;

export function isAppPath(pathname: string): boolean {
  if (pathname === "/u") return true;
  return APP_PATH_PREFIXES.some((prefix) =>
    prefix.endsWith("/")
      ? pathname.startsWith(prefix)
      : pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export const WEB_CACHE_CONTROL = {
  /** Every HTML page: always ask again, so a new release shows at the next load. */
  html: "no-cache",
  /** Built files under /assets have a content hash in their name. */
  assets: "public, max-age=31536000, immutable",
} as const;

export const PERMISSIONS_POLICY =
  "camera=(), microphone=(), geolocation=(), payment=(), usb=(), " +
  "publickey-credentials-get=(self), publickey-credentials-create=(self)";

/** The Content-Security-Policy value: scripts only from the own origin, fetches only to it and the API. */
export function contentSecurityPolicy({ apiOrigin }: WebHeaderOptions): string {
  const secure = isHttps(apiOrigin);
  const connect = apiOrigin ? `'self' ${originOf(apiOrigin)}` : "'self'";
  const directives = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ];
  // Only for the hosted https site: on plain http (local) it would turn every API call into https.
  if (secure) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

/**
 * Headers for every web response, as [name, value] pairs. HSTS only for the hosted https site; browsers
 * ignore it on http anyway, and a local run should not pretend to be https.
 */
export function webSecurityHeaders(options: WebHeaderOptions): [string, string][] {
  const headers: [string, string][] = [["Content-Security-Policy", contentSecurityPolicy(options)]];
  if (isHttps(options.apiOrigin)) {
    headers.push(["Strict-Transport-Security", "max-age=63072000; includeSubDomains"]);
  }
  headers.push(
    ["X-Content-Type-Options", "nosniff"],
    ["Referrer-Policy", "no-referrer"],
    ["X-Frame-Options", "DENY"],
    ["Cross-Origin-Opener-Policy", "same-origin"],
    ["Cross-Origin-Resource-Policy", "same-origin"],
    ["Permissions-Policy", PERMISSIONS_POLICY],
  );
  return headers;
}

function isHttps(origin: string | null): boolean {
  return origin !== null && origin.startsWith("https://");
}

/** Only the origin goes into the policy, never a path (a trailing slash or /api would not match). */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    throw new Error(`The API origin "${url}" is not a URL.`);
  }
}
