import { z } from "zod";

export const ERROR_STATUS = {
  validation_failed: 422,
  not_found: 404,
  conflict: 409,
  unauthorized: 401,
  forbidden: 403,
  unknown_host: 421,
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
