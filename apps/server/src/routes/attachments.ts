import {
  API_PREFIX,
  Attachment,
  AttachmentFileParams,
  AttachmentUploadQuery,
  FileList,
  IdParams,
  MAX_ATTACHMENT_BYTES,
} from "@organizer/shared";
import { createReadStream } from "node:fs";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  attachmentFile,
  deleteAttachment,
  getAttachment,
  isInline,
  listFiles,
  storeAttachment,
} from "../services/attachments.ts";
import { actorOf, type App, ctxOf, type Deps, filesDirOf } from "./types.ts";

/** User files never run in the app's origin: sandboxed, no sniffing, images inline, the rest as download. */
const FILE_CSP = "default-src 'none'; sandbox";

export function attachmentRoutes(app: App, deps: Deps): void {
  const tags = ["attachments"];

  // The raw-body parser lives only in this scope, so JSON parsing of every other route stays as it is.
  app.register(async (scope: App) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
    scope.post(
      `${API_PREFIX}/attachments`,
      {
        bodyLimit: MAX_ATTACHMENT_BYTES,
        config: { tooLargeMessage: "Files can be up to 25 MB.", upload: true },
        schema: {
          tags,
          summary: "Upload a file: the raw bytes as body (any Content-Type), ?name=<file name>",
          querystring: AttachmentUploadQuery,
          response: { 201: Attachment },
        },
      },
      async (request, reply) => {
        const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        const attachment = storeAttachment(
          ctxOf(request, deps),
          { dir: filesDirOf(request, deps), limitBytes: deps.filesLimitBytes },
          actorOf(request),
          request.query.name,
          body,
        );
        return reply.status(201).send(attachment);
      },
    );
  });

  // The files page is the browser's: tokens can't list or delete files (deleting breaks links).
  const sessionOnly = { access: "session" as const };
  app.get(
    `${API_PREFIX}/attachments`,
    {
      config: sessionOnly,
      schema: {
        tags,
        summary: "Every uploaded file, newest first, with where it is linked from and the space used",
        response: { 200: FileList },
      },
    },
    async (request) => listFiles(ctxOf(request, deps), deps.filesLimitBytes),
  );

  app.delete(
    `${API_PREFIX}/attachments/:id`,
    {
      config: sessionOnly,
      schema: {
        tags,
        summary: "Delete a file and free its space; links to it then show a missing file",
        params: IdParams,
      },
    },
    async (request, reply) => {
      deleteAttachment(ctxOf(request, deps), filesDirOf(request, deps), request.params.id);
      return reply.status(204).send();
    },
  );

  app.get(
    `${API_PREFIX}/attachments/:id/meta`,
    { schema: { tags, summary: "Attachment details", params: IdParams, response: { 200: Attachment } } },
    async (request) => getAttachment(ctxOf(request, deps), request.params.id),
  );

  const sendFile = (request: FastifyRequest, id: number, reply: FastifyReply) => {
    const { row, path, size } = attachmentFile(ctxOf(request, deps), filesDirOf(request, deps), id);
    const disposition = isInline(row.mimeType) ? "inline" : "attachment";
    return reply
      .header("Content-Type", row.mimeType)
      .header("Content-Length", size)
      .header("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(row.name)}`)
      .header("Content-Security-Policy", FILE_CSP)
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "private, max-age=31536000, immutable")
      .send(createReadStream(path));
  };
  app.get(
    `${API_PREFIX}/attachments/:id`,
    { schema: { tags, summary: "The file (images inline, everything else as download)", params: IdParams } },
    async (request, reply) => sendFile(request, request.params.id, reply),
  );
  app.get(
    `${API_PREFIX}/attachments/:id/:name`,
    {
      schema: {
        tags,
        summary: "The file; the name is only there for readable links",
        params: AttachmentFileParams,
      },
    },
    async (request, reply) => sendFile(request, request.params.id, reply),
  );
}
