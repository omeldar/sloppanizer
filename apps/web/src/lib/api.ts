import type { z } from "zod";
import { ApiError, NETWORK_MESSAGE, responseError, safeJson } from "./apiError.ts";
import { apiUrl } from "./config.ts";
import { duringUpdate } from "./serverVersion.ts";
import { accessToken, renewAccessToken, sessionEnded } from "./session.ts";

export { ApiError } from "./apiError.ts";

export type Query = Record<string, string | number | readonly string[] | undefined | null>;

export function queryString(query: Query | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) params.set(key, value.join(","));
    } else {
      params.set(key, String(value));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** Sent as JSON. */
  body?: unknown;
  /** Sent as is (file uploads); the server checks the type itself. */
  raw?: Blob;
  query?: Query;
  accept?: string;
}

/**
 * Asks the user to confirm it is them (the "Confirm it is you" dialog) when the server wants a fresh
 * sign-in for a sensitive action. Resolves true once confirmed, false when they cancel.
 */
export type ReauthHandler = () => Promise<boolean>;
let reauthHandler: ReauthHandler | null = null;

/** The app's reauth dialog registers here; null removes it. */
export function setReauthHandler(handler: ReauthHandler | null): void {
  reauthHandler = handler;
}

/** Calls `/api/v1<path>` with this tab's account and parses the answer with the contract schema. */
export async function api<S extends z.ZodType>(
  schema: S,
  path: string,
  options: RequestOptions = {},
): Promise<z.output<S>> {
  const json = await send(path, options);
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    console.error(`Unexpected answer from ${path}`, parsed.error.issues);
    throw duringUpdate(
      new ApiError(
        200,
        "bad_response",
        "The server sent an answer this version of the app does not understand. Reload the page.",
      ),
    );
  }
  return parsed.data;
}

/** For calls whose answer the app does not need (e.g. DELETE). */
export async function apiVoid(path: string, options: RequestOptions = {}): Promise<void> {
  await send(path, options);
}

/** A file from the API (downloads, images) with the same sign-in handling as every call. */
export async function apiFile(
  path: string,
  options: RequestOptions = {},
): Promise<{ blob: Blob; fileName: string | null }> {
  const response = await authorizedFetch(path, { ...options, accept: options.accept ?? "*/*" });
  return {
    blob: await response.blob(),
    fileName: dispositionName(response.headers.get("content-disposition")),
  };
}

/** The file name of a Content-Disposition header (RFC 6266, also the filename* form), or null. */
export function dispositionName(header: string | null): string | null {
  if (!header) return null;
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header)?.[1];
  if (extended) {
    try {
      return decodeURIComponent(extended.trim());
    } catch {
      // Broken percent encoding: try the plain form.
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/.exec(header);
  const name = (plain?.[1] ?? plain?.[2])?.trim();
  return name ? name : null;
}

async function send(path: string, options: RequestOptions): Promise<unknown> {
  const response = await authorizedFetch(path, options);
  const text = await response.text();
  return text ? safeJson(text) : null;
}

/**
 * Sends the request with the tab's access token. A 401 gets one new token and one retry; a second 401
 * ends the session. A 403 reauth_required opens the confirm dialog and, once confirmed, repeats the call
 * once. Any other failure becomes an ApiError with the server's message.
 */
async function authorizedFetch(path: string, options: RequestOptions): Promise<Response> {
  const url = `${apiUrl(path)}${queryString(options.query)}`;
  let token = await accessToken();
  let response = await fetchOnce(url, options, token);
  // On /auth/* a 401 means wrong credentials (a reauth password, say), not an expired token.
  if (response.status === 401 && token && !path.startsWith("/auth/")) {
    token = await renewAccessToken(token);
    response = await fetchOnce(url, options, token);
    if (response.status === 401) sessionEnded();
  }
  if (response.status === 403 && reauthHandler) {
    const text = await response.clone().text();
    const error = responseError(403, safeJson(text));
    if (error.code === "reauth_required" && (await reauthHandler())) {
      response = await fetchOnce(url, options, await accessToken());
    }
  }
  if (!response.ok) {
    const text = await response.text();
    throw duringUpdate(responseError(response.status, text ? safeJson(text) : null));
  }
  return response;
}

async function fetchOnce(url: string, options: RequestOptions, token: string | null): Promise<Response> {
  const { method = "GET", body, raw } = options;
  const headers: Record<string, string> = { accept: options.accept ?? "application/json" };
  if (raw !== undefined) headers["content-type"] = "application/octet-stream";
  else if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    return await fetch(url, {
      method,
      // Bearer tokens only: no cookies go to the API, so there is nothing to forge across sites.
      credentials: "omit",
      headers,
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
  } catch {
    throw new ApiError(0, "network", NETWORK_MESSAGE);
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong. Try again.";
}
