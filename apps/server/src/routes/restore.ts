import {
  API_PREFIX,
  ApplyRestore,
  BackupFile,
  BackupParams,
  RestoreParams,
  RestorePreview,
  RestoreResult,
  RestoreUploadQuery,
} from "@organizer/shared";
import { createReadStream } from "node:fs";
import { z } from "zod";
import {
  applyRestore,
  backupPath,
  discardStaged,
  getStaged,
  listBackups,
  stageUpload,
} from "../services/restore.ts";
import { type App, authOf, type Deps, restoreCtxOf } from "./types.ts";

/**
 * Restore of the caller's account from an export zip: upload and check, preview, apply (needs a recent
 * sign-in); its safety copies. Session only.
 */
export function restoreRoutes(app: App, deps: Deps): void {
  const tags = ["restore"];
  const config = { access: "session" as const };

  // The raw-body parser lives only in this scope (like uploads).
  app.register(async (scope: App) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
    scope.post(
      `${API_PREFIX}/restore`,
      {
        bodyLimit: deps.limits.uploadBytes,
        config: { ...config, tooLargeMessage: "Export files can be up to 1 GB.", upload: true },
        schema: {
          tags,
          summary: "Upload an export zip (raw body, ?name=) to check it and get a preview",
          querystring: RestoreUploadQuery,
          response: { 201: RestorePreview },
        },
      },
      async (request, reply) => {
        const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        return reply.status(201).send(stageUpload(restoreCtxOf(request, deps), request.query.name, body));
      },
    );
  });

  app.get(
    `${API_PREFIX}/restore/backups`,
    {
      config,
      schema: {
        tags,
        summary: "Safety copies made before restores, newest first",
        response: { 200: z.array(BackupFile) },
      },
    },
    async (request) => listBackups(deps, authOf(request).accountId),
  );
  app.get(
    `${API_PREFIX}/restore/backups/:fileName`,
    { config, schema: { tags, summary: "Download a safety copy", params: BackupParams } },
    async (request, reply) => {
      const path = backupPath(deps, authOf(request).accountId, request.params.fileName);
      return reply
        .header("Content-Type", "application/zip")
        .header("Content-Disposition", `attachment; filename="${request.params.fileName}"`)
        .header("Cache-Control", "no-store")
        .send(createReadStream(path));
    },
  );
  app.get(
    `${API_PREFIX}/restore/:uploadId`,
    {
      config,
      schema: {
        tags,
        summary: "Preview of a staged upload",
        params: RestoreParams,
        response: { 200: RestorePreview },
      },
    },
    async (request) => getStaged({ ...deps, accountId: authOf(request).accountId }, request.params.uploadId),
  );
  app.delete(
    `${API_PREFIX}/restore/:uploadId`,
    { config, schema: { tags, summary: "Drop a staged upload", params: RestoreParams } },
    async (request, reply) => {
      discardStaged({ ...deps, accountId: authOf(request).accountId }, request.params.uploadId);
      return reply.status(204).send();
    },
  );
  app.post(
    `${API_PREFIX}/restore/:uploadId/apply`,
    {
      config: { ...config, reauth: true },
      schema: {
        tags,
        summary:
          'Replace the account\'s data with the staged export (body { confirm: "replace" }); a safety copy is saved first',
        params: RestoreParams,
        body: ApplyRestore,
        response: { 200: RestoreResult },
      },
    },
    async (request) => applyRestore(restoreCtxOf(request, deps), request.params.uploadId),
  );
}
