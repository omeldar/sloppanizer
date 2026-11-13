import { API_PREFIX, Settings } from "@organizer/shared";
import { getSettings } from "../services/settings.ts";
import { type App, ctxOf, type Deps } from "./types.ts";

export function settingsRoutes(app: App, deps: Deps): void {
  app.get(
    `${API_PREFIX}/settings`,
    {
      config: { access: "session" },
      schema: {
        tags: ["settings"],
        summary: "Settings page data of the account (session only)",
        response: { 200: Settings },
      },
    },
    async (request) => getSettings(ctxOf(request, deps), deps),
  );
}
