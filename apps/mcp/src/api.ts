import { readFileSync } from "node:fs";
import { API_PREFIX, ErrorBody, TOKEN_PATTERN } from "@organizer/shared";
import type { McpConfig } from "./config.ts";

/** A problem the user (or the assistant) can fix; the message says how. */
export class ToolError extends Error {}

/** An error response of the REST API. */
export class ApiError extends ToolError {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function notReachableMessage(url: string): string {
  return `Sloppanizer is not reachable at ${url}. Check the URL and your network.`;
}

const TIMEOUT_MS = 15_000;

type Query = Record<string, string | number | boolean | readonly (string | number)[] | null | undefined>;

export interface Api {
  get<T>(path: string, query?: Query): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  delete(path: string, query?: Query): Promise<void>;
}

function readToken(file: string): string {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8").trim();
  } catch {
    throw new ToolError(
      `No API token at ${file}. Create one in Sloppanizer under Settings, API tokens, and save it in this file.`,
    );
  }
  if (!TOKEN_PATTERN.test(raw)) {
    throw new ToolError(
      `The file ${file} does not hold a Sloppanizer token (spz_ plus 40 letters and digits).`,
    );
  }
  return raw;
}

function toSearch(query: Query | undefined): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** REST client for /api/v1 with the token from the token file. */
export function createApi(config: McpConfig, fetchImpl: typeof fetch = fetch): Api {
  async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
    const token = readToken(config.tokenFile);
    let response: Response;
    try {
      response = await fetchImpl(`${config.url}${API_PREFIX}${path}${toSearch(query)}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ToolError(notReachableMessage(config.url));
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (response.ok) return json as T;
    const parsed = ErrorBody.safeParse(json);
    if (response.status === 401) {
      throw new ApiError(
        401,
        "unauthorized",
        `The token in ${config.tokenFile} was not accepted: it was revoked or has expired, or its account is disabled. Create a new one in Sloppanizer under Settings, API tokens.`,
      );
    }
    if (!parsed.success) {
      throw new ApiError(
        response.status,
        "internal",
        `${config.url} answered ${response.status} without a Sloppanizer error body. Is SLOPPANIZER_URL pointing at the Sloppanizer API?`,
      );
    }
    const { code, message, details } = parsed.data.error;
    throw new ApiError(response.status, code, message, details);
  }

  return {
    get: (path, query) => request("GET", path, undefined, query),
    post: (path, body) => request("POST", path, body),
    patch: (path, body) => request("PATCH", path, body),
    delete: (path, query) => request("DELETE", path, undefined, query),
  };
}
