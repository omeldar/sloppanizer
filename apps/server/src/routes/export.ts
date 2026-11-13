import { API_PREFIX } from "@organizer/shared";
import { buildExport } from "../services/export.ts";
import { type App, authOf, ctxOf, type Deps, filesDirOf } from "./types.ts";

export function exportRoutes(app: App, deps: Deps): void {
  app.get(
    `${API_PREFIX}/export.zip`,
    {
      config: { access: "write" },
      schema: {
        tags: ["export"],
        summary: "Download the account's data as a zip (session or write token); sets lastExportAt",
      },
    },
    async (request, reply) => {
      const { fileName, stream } = buildExport(ctxOf(request, deps), {
        filesDir: filesDirOf(request, deps),
        appVersion: deps.version,
        account: authOf(request).account,
      });
      return reply
        .header("Content-Type", "application/zip")
        .header("Content-Disposition", `attachment; filename="${fileName}"`)
        .header("Cache-Control", "no-store")
        .send(stream);
    },
  );
}
