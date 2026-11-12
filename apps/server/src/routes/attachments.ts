import {
  API_PREFIX,
  Attachment,
  AttachmentFileParams,
  AttachmentUploadQuery,
  IdParams,
  MAX_ATTACHMENT_BYTES,
} from "@organizer/shared";
import { createReadStream } from "node:fs";
import type { FastifyReply } from "fastify";
import { attachmentFile, getAttachment, isInline, storeAttachment } from "../services/attachments.ts";
import { actorOf, type App, type Deps } from "./types.ts";

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
        config: { tooLargeMessage: "Files can be up to 25 MB." },
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
          deps,
          deps.attachmentsDir,
          actorOf(request),
          request.query.name,
          body,
        );
        return reply.status(201).send(attachment);
      },
    );
  });

  app.get(
    `${API_PREFIX}/attachments/:id/meta`,
    { schema: { tags, summary: "Attachment details", params: IdParams, response: { 200: Attachment } } },
    async (request) => getAttachment(deps.db, request.params.id),
  );

  const sendFile = (id: number, reply: FastifyReply) => {
    const { row, path, size } = attachmentFile(deps.db, deps.attachmentsDir, id);
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
    async (request, reply) => sendFile(request.params.id, reply),
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
    async (request, reply) => sendFile(request.params.id, reply),
  );
}
