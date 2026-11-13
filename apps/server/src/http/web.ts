import fastifyStatic from "@fastify/static";
import { errorBody, isAppPath, WEB_CACHE_CONTROL, webSecurityHeaders } from "@organizer/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Without SLOPPANIZER_WEB_DIR the server is an API only: `/` says so in JSON and every other unknown path
 * is a JSON 404. With it (local web mode, one origin, `docker compose -f deploy/compose.local.yaml up`) it
 * also serves the built web app: `/` the landing page, the app paths app.html, files under it as they are,
 * all with the web app's security headers.
 */

const isApi = (url: string): boolean => url === "/api" || url.startsWith("/api/");

/** The 404 of a route that does not exist. Admin routes answer non-admins with exactly this body. */
export const unknownRouteBody = (method: string, path: string) =>
  errorBody("not_found", `${method} ${path} does not exist. See /api/docs for the API.`);

const WEB_HEADERS = webSecurityHeaders({ apiOrigin: null });

function withWebHeaders(reply: FastifyReply): FastifyReply {
  for (const [name, value] of WEB_HEADERS) reply.header(name, value);
  return reply;
}

async function sendPage(reply: FastifyReply, file: string, status = 200): Promise<FastifyReply> {
  const html = await readFile(file, "utf8");
  return withWebHeaders(reply)
    .status(status)
    .type("text/html; charset=utf-8")
    .header("Cache-Control", WEB_CACHE_CONTROL.html)
    .send(html);
}

export async function registerWeb(app: FastifyInstance, webDir: string | null): Promise<void> {
  const pages = webDir === null ? null : { index: join(webDir, "index.html"), app: join(webDir, "app.html") };
  const notFoundPage = webDir === null ? null : join(webDir, "404.html");

  if (webDir !== null && pages && existsSync(pages.index)) {
    await app.register(fastifyStatic, {
      root: webDir,
      index: false,
      wildcard: true,
      // The HTML pages go through sendPage (headers, no-cache).
      allowedPath: (pathName) => !pathName.endsWith(".html"),
      setHeaders: (reply, path) => {
        for (const [name, value] of WEB_HEADERS) reply.header(name, value);
        reply.header(
          "Cache-Control",
          path.includes(`${join(webDir, "assets")}/`) ? WEB_CACHE_CONTROL.assets : WEB_CACHE_CONTROL.html,
        );
      },
    });
    app.get("/", { schema: { hide: true } }, async (_request, reply) => sendPage(reply, pages.index));
  } else {
    app.get("/", { schema: { hide: true } }, async () => ({ name: "Sloppanizer API", docs: "/api/docs" }));
  }

  app.setNotFoundHandler(async (request, reply) => {
    const path = request.url.split("?")[0] ?? "/";
    const isPageRequest = !isApi(path) && (request.method === "GET" || request.method === "HEAD");
    if (pages && isPageRequest && existsSync(pages.app)) {
      if (isAppPath(path)) return sendPage(reply, pages.app);
      if (notFoundPage && existsSync(notFoundPage) && (request.headers.accept ?? "").includes("text/html")) {
        return sendPage(reply, notFoundPage, 404);
      }
    }
    return reply.status(404).send(unknownRouteBody(request.method, path));
  });
}
