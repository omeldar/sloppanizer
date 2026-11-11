import fastifyStatic from "@fastify/static";
import { errorBody } from "@organizer/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setSessionCookie } from "./security.ts";

const PLACEHOLDER = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>organizer</title></head>
<body><p>The web app is not built yet. Run <code>pnpm --filter @organizer/web build</code> and reload.</p></body></html>
`;

const isApi = (url: string): boolean => url === "/api" || url.startsWith("/api/");

/**
 * Serves the built web app with an SPA fallback. Every HTML response sets the browser session cookie.
 * Without a build a short placeholder page is served (it still sets the cookie, handy in development).
 */
export async function registerWeb(app: FastifyInstance, webDir: string): Promise<void> {
  const indexPath = join(webDir, "index.html");
  const hasBuild = existsSync(indexPath);

  const sendApp = async (request: FastifyRequest, reply: FastifyReply) => {
    setSessionCookie(request, reply);
    const html = existsSync(indexPath) ? await readFile(indexPath, "utf8") : PLACEHOLDER;
    return reply.type("text/html; charset=utf-8").header("Cache-Control", "no-cache").send(html);
  };

  if (hasBuild) {
    await app.register(fastifyStatic, {
      root: webDir,
      index: false,
      wildcard: true,
      allowedPath: (pathName) => pathName !== "/index.html",
      setHeaders: (reply, path) => {
        if (path.includes(`${join(webDir, "assets")}/`))
          reply.header("Cache-Control", "public, max-age=31536000, immutable");
      },
    });
  }
  app.get("/", sendApp);

  app.setNotFoundHandler(async (request, reply) => {
    const path = request.url.split("?")[0] ?? "/";
    const wantsHtml = (request.headers.accept ?? "").includes("text/html");
    const lastSegment = path.slice(path.lastIndexOf("/") + 1);
    if (
      !isApi(path) &&
      (request.method === "GET" || request.method === "HEAD") &&
      (wantsHtml || !lastSegment.includes("."))
    ) {
      return sendApp(request, reply);
    }
    return reply
      .status(404)
      .send(errorBody("not_found", `${request.method} ${path} does not exist. See /api/docs for the API.`));
  });
}
