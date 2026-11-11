import { API_PREFIX, ErrorBody, type ErrorCode } from "@organizer/shared";
import type { z } from "zod";

/** A failed API call, with the server's code and message when it sent one. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode | "network" | "bad_response";
  readonly details: unknown;

  constructor(status: number, code: ApiError["code"], message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

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
  body?: unknown;
  query?: Query;
}

/** Calls `/api/v1<path>` with the browser session and parses the answer with the contract schema. */
export async function api<S extends z.ZodType>(
  schema: S,
  path: string,
  options: RequestOptions = {},
): Promise<z.output<S>> {
  const json = await send(path, options);
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    console.error(`Unexpected answer from ${path}`, parsed.error.issues);
    throw new ApiError(
      200,
      "bad_response",
      "The server sent an answer this version of the app does not understand. Reload the page.",
    );
  }
  return parsed.data;
}

/** For calls whose answer the app does not need (e.g. DELETE). */
export async function apiVoid(path: string, options: RequestOptions = {}): Promise<void> {
  await send(path, options);
}

async function send(path: string, { method = "GET", body, query }: RequestOptions): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${API_PREFIX}${path}${queryString(query)}`, {
      method,
      credentials: "same-origin",
      headers:
        body === undefined
          ? { accept: "application/json" }
          : { "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      0,
      "network",
      "organizer is not reachable. Check that the server is running, then try again.",
    );
  }
  const text = await response.text();
  const json: unknown = text ? safeJson(text) : null;
  if (!response.ok) {
    const error = ErrorBody.safeParse(json);
    if (error.success) {
      throw new ApiError(
        response.status,
        error.data.error.code,
        error.data.error.message,
        error.data.error.details,
      );
    }
    throw new ApiError(
      response.status,
      response.status === 401 ? "unauthorized" : "internal",
      response.status === 401
        ? "Your session has ended. Reload the page to start a new one."
        : `The server answered with status ${response.status}. Try again; if it keeps happening, check the server log.`,
    );
  }
  return json;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong. Try again.";
}
