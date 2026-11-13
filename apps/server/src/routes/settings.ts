import { API_PREFIX, FolderExport, FolderExportListItem, Settings } from "@organizer/shared";
import { z } from "zod";
import { getSettings, listFolderExports, writeFolderExport } from "../services/folder-export.ts";
import { authOf, type App, type Deps } from "./types.ts";

export function settingsRoutes(app: App, deps: Deps): void {
  app.get(
    `${API_PREFIX}/settings`,
    {
      config: { access: "session" },
      schema: {
        tags: ["settings"],
        summary: "Settings page data (session only)",
        response: { 200: Settings },
      },
    },
    async () => getSettings(deps),
  );
  app.post(
    `${API_PREFIX}/export/folder`,
    {
      config: { access: "write" },
      schema: {
        tags: ["export"],
        summary: "Write an export zip to <data dir>/exports (keeps the newest 4); sets lastExportAt",
        response: { 201: FolderExport },
      },
    },
    async (_request, reply) => reply.status(201).send(await writeFolderExport(deps)),
  );
  app.get(
    `${API_PREFIX}/export/folder`,
    {
      schema: {
        tags: ["export"],
        summary: "The export zips in the export folder, newest first (full paths for the session only)",
        response: { 200: z.array(FolderExportListItem) },
      },
    },
    async (request) => {
      const list = listFolderExports(deps.dataDir);
      // Absolute paths name the data folder and the user; tokens get the file names only.
      return authOf(request).via === "session" ? list : list.map(({ path: _path, ...rest }) => rest);
    },
  );
}
