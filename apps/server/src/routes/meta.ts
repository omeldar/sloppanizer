import { API_PREFIX, Health, Me } from "@organizer/shared";
import type { App, Deps } from "./types.ts";

export function metaRoutes(app: App, deps: Deps): void {
  app.get(
    `${API_PREFIX}/health`,
    {
      config: { access: "public" },
      schema: { tags: ["meta"], summary: "Liveness check (no auth)", response: { 200: Health } },
    },
    async () => ({ ok: true as const, version: deps.version }),
  );
  app.get(
    `${API_PREFIX}/me`,
    { schema: { tags: ["meta"], summary: "Who is calling", response: { 200: Me } } },
    async (request) => {
      const auth = request.auth;
      if (!auth) throw new Error("auth missing after the security hook");
      return { actor: auth.actor, via: auth.via, scope: auth.scope };
    },
  );
}
