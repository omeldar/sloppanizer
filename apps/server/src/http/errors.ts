import { ERROR_STATUS, type ErrorCode, errorBody } from "@organizer/shared";
import type { FastifyError, FastifyInstance } from "fastify";
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from "fastify-type-provider-zod";

/** An error the API answers with `{ error: { code, message, details? } }`. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

export const notFound = (what: string, id: number | string): ApiError =>
  new ApiError("not_found", `${what} ${id} does not exist. Check the id.`);

interface Issue {
  path: string;
  message: string;
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.status).send(errorBody(error.code, error.message, error.details));
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      const issues: Issue[] = error.validation.map((v) => ({
        path: [error.validationContext ?? "", ...(v.instancePath ? v.instancePath.split("/").slice(1) : [])]
          .filter(Boolean)
          .join("."),
        message: v.message ?? "Invalid value.",
      }));
      const first = issues[0];
      const summary = first ? `${first.path || "request"}: ${first.message}` : "The request is not valid.";
      return reply
        .status(422)
        .send(errorBody("validation_failed", `Invalid request. ${summary}`, { issues }));
    }
    if (isResponseSerializationError(error)) {
      request.log.error({ err: error, issues: error.cause }, "response does not match its schema");
      return reply
        .status(500)
        .send(errorBody("internal", "The server built an invalid response. See the server log."));
    }
    if (error.statusCode === 415 || error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      return reply.status(422).send(errorBody("validation_failed", "Send the body as application/json."));
    }
    if (
      error.code === "FST_ERR_CTP_EMPTY_JSON_BODY" ||
      error.code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
      error.statusCode === 400
    ) {
      return reply.status(422).send(errorBody("validation_failed", `Invalid request: ${error.message}`));
    }
    if (error.statusCode === 413) {
      return reply.status(422).send(errorBody("validation_failed", "The request body is too large."));
    }
    request.log.error({ err: error }, "unhandled error");
    return reply
      .status(500)
      .send(errorBody("internal", "Something went wrong on the server. See the server log."));
  });
}
