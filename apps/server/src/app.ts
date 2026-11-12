import fastifyCookie from "@fastify/cookie";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyServerOptions } from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { join } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { type Clock, systemClock } from "./clock.ts";
import type { Config } from "./config.ts";
import { ensureAttachmentsDir, ensureDataDir, DB_FILE, loadSecret } from "./data-dir.ts";
import { openDb } from "./db/index.ts";
import { registerErrorHandling } from "./http/errors.ts";
import { registerSecurity } from "./http/security.ts";
import { registerWeb } from "./http/web.ts";
import { attachmentRoutes } from "./routes/attachments.ts";
import { commentRoutes } from "./routes/comments.ts";
import { exportRoutes } from "./routes/export.ts";
import { labelRoutes } from "./routes/labels.ts";
import { metaRoutes } from "./routes/meta.ts";
import { noteRoutes } from "./routes/notes.ts";
import { peopleStatsRoutes } from "./routes/people-stats.ts";
import { peopleRoutes } from "./routes/people.ts";
import { personTagRoutes } from "./routes/person-tags.ts";
import { projectRoutes } from "./routes/projects.ts";
import { searchRoutes } from "./routes/search.ts";
import { todoRelationRoutes } from "./routes/todo-relations.ts";
import { todoRoutes } from "./routes/todos.ts";
import { tokenRoutes } from "./routes/tokens.ts";
import { topicRoutes } from "./routes/topics.ts";
import type { Deps } from "./routes/types.ts";
import { repairScopeConflicts } from "./services/labels.ts";
import { rebuildSearchIndex } from "./services/search-index.ts";

export const VERSION = packageJson.version;

export interface BuildOptions {
  config: Config;
  clock?: Clock;
  logger?: FastifyServerOptions["logger"];
}

/** Builds the HTTP app: opens the data dir and database, registers security, API, docs and web app. */
export async function buildApp(options: BuildOptions) {
  const { config } = options;
  ensureDataDir(config.dataDir);
  const secret = loadSecret(config.dataDir);
  const db = openDb(join(config.dataDir, DB_FILE));
  // The index is derived data: rebuilding at every start heals it (and covers a restore).
  rebuildSearchIndex(db);
  const deps: Deps = {
    db,
    clock: options.clock ?? systemClock,
    timeZone: config.timeZone,
    version: VERSION,
    attachmentsDir: ensureAttachmentsDir(config.dataDir),
  };

  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 1_048_576,
    routerOptions: { ignoreTrailingSlash: true },
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("onClose", async () => db.$client.close());
  const repaired = repairScopeConflicts(deps);
  if (repaired > 0) app.log.warn(`removed duplicate scope labels from ${repaired} todos`);

  await app.register(fastifyCookie, { secret });
  registerSecurity(app, { db, clock: deps.clock, allowedHosts: config.allowedHosts });
  registerErrorHandling(app);

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "organizer API",
        version: VERSION,
        description:
          "Personal todos and notes. Auth: the browser session cookie, or Authorization: Bearer org_... " +
          "(read tokens: GET only). Errors: { error: { code, message, details? } }.",
      },
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
      security: [{ bearer: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(fastifySwaggerUi, { routePrefix: "/api/docs", staticCSP: false });
  app.get("/api/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  metaRoutes(app, deps);
  projectRoutes(app, deps);
  labelRoutes(app, deps);
  peopleRoutes(app, deps);
  peopleStatsRoutes(app, deps);
  topicRoutes(app, deps);
  personTagRoutes(app, deps);
  todoRoutes(app, deps);
  todoRelationRoutes(app, deps);
  commentRoutes(app, deps);
  noteRoutes(app, deps);
  attachmentRoutes(app, deps);
  searchRoutes(app, deps);
  tokenRoutes(app, deps);
  exportRoutes(app, deps);
  await registerWeb(app, config.webDir);

  return { app, deps };
}
