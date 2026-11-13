import { ErrorBody, type ErrorCode } from "@organizer/shared";

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

export const NETWORK_MESSAGE = "Sloppanizer is not reachable. Check your connection, then try again.";
export const SESSION_ENDED_MESSAGE = "You were signed out. Sign in again to go on.";

/** The error for a failed response: the server's code and message, else a plain one for the status. */
export function responseError(status: number, json: unknown): ApiError {
  const error = ErrorBody.safeParse(json);
  if (error.success) {
    return new ApiError(status, error.data.error.code, error.data.error.message, error.data.error.details);
  }
  if (status === 401) return new ApiError(401, "unauthorized", SESSION_ENDED_MESSAGE);
  return new ApiError(
    status,
    "internal",
    `The server answered with status ${status}. Try again; if it keeps happening, tell the admin.`,
  );
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
