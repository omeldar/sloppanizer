import { API_PREFIX } from "@organizer/shared";
import { buildExport } from "../services/export.ts";
import type { App, Deps } from "./types.ts";

export function exportRoutes(app: App, deps: Deps): void {
  app.get(
    `${API_PREFIX}/export.zip`,
    {
      config: { access: "write" },
      schema: {
        tags: ["export"],
        summary: "Download everything as a zip (session or write token); sets lastExportAt",
      },
    },
    async (_request, reply) => {
      const { fileName, stream } = buildExport(deps, {
        attachmentsDir: deps.attachmentsDir,
        appVersion: deps.version,
      });
      return reply
        .header("Content-Type", "application/zip")
        .header("Content-Disposition", `attachment; filename="${fileName}"`)
        .header("Cache-Control", "no-store")
        .send(stream);
    },
  );
}
