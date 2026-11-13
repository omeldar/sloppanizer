import { API_PREFIX, Health, Me } from "@organizer/shared";
import { sql } from "drizzle-orm";
import { type App, authOf, type Deps } from "./types.ts";

export function metaRoutes(app: App, deps: Deps): void {
  app.get(
    `${API_PREFIX}/health`,
    {
      config: { access: "public" },
      schema: { tags: ["meta"], summary: "Liveness check (no auth)", response: { 200: Health } },
    },
    async () => {
      // Fails (500) when the database cannot answer.
      deps.db.get(sql`SELECT 1`);
      return { ok: true as const, version: deps.version };
    },
  );
  app.get(
    `${API_PREFIX}/me`,
    { schema: { tags: ["meta"], summary: "Who is calling and their account", response: { 200: Me } } },
    async (request) => {
      const { actor, via, scope, account } = authOf(request);
      const { id, username, displayName, color, role } = account;
      return { actor, via, scope, account: { id, username, displayName, color, role } };
    },
  );
}
