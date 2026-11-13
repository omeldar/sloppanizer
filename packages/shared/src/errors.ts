import { z } from "zod";

export const ERROR_STATUS = {
  validation_failed: 422,
  not_found: 404,
  conflict: 409,
  unauthorized: 401,
  forbidden: 403,
  /** A sensitive action needs a fresh sign-in (POST /auth/reauth, then repeat the call once). */
  reauth_required: 403,
  too_large: 413,
  unsupported_type: 415,
  unknown_host: 421,
  /** details { retryAfterSeconds }; the response also has a Retry-After header. */
  too_many_requests: 429,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;
export const ErrorCode = z.enum(Object.keys(ERROR_STATUS) as [ErrorCode, ...ErrorCode[]]);

/** Every error response: `{ error: { code, message, details? } }`. */
export const ErrorBody = z.strictObject({
  error: z.strictObject({
    code: ErrorCode,
    /** Says what is wrong and how to fix it. */
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

export function errorBody(code: ErrorCode, message: string, details?: unknown): ErrorBody {
  return details === undefined ? { error: { code, message } } : { error: { code, message, details } };
}
