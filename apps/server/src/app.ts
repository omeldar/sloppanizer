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
import { type Config, proxyMatcher } from "./config.ts";
import { DB_FILE, ensureDataDir, ensurePrivateDir, loadSecret } from "./data-dir.ts";
import { accounts } from "./db/auth-schema.ts";
import { openDb } from "./db/index.ts";
import { registerErrorHandling } from "./http/errors.ts";
import { registerSecurity } from "./http/security.ts";
import { registerWeb } from "./http/web.ts";
import { attachmentRoutes } from "./routes/attachments.ts";
import { registerAccountApi } from "./routes/auth.ts";
import { aiRoutes } from "./routes/ai.ts";
import { calendarRoutes } from "./routes/calendar.ts";
import { commentRoutes } from "./routes/comments.ts";
import { drawingRoutes } from "./routes/drawings.ts";
import { exportRoutes } from "./routes/export.ts";
import { labelRoutes } from "./routes/labels.ts";
import { mcpRoutes } from "./routes/mcp.ts";
import { blockSeriesRoutes } from "./routes/block-series.ts";
import { meetingRoutes } from "./routes/meetings.ts";
import { metaRoutes } from "./routes/meta.ts";
import { noteRoutes } from "./routes/notes.ts";
import { notificationRoutes } from "./routes/notifications.ts";
import { oauthRoutes } from "./routes/oauth.ts";
import { plannerRoutes } from "./routes/planner.ts";
import { peopleStatsRoutes } from "./routes/people-stats.ts";
import { peopleRoutes } from "./routes/people.ts";
import { personTagRoutes } from "./routes/person-tags.ts";
import { projectRoutes } from "./routes/projects.ts";
import { spaceRoutes } from "./routes/spaces.ts";
import { restoreRoutes } from "./routes/restore.ts";
import { searchRoutes } from "./routes/search.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { todoRelationRoutes } from "./routes/todo-relations.ts";
import { todoRoutes } from "./routes/todos.ts";
import { tokenRoutes } from "./routes/tokens.ts";
import { topicRoutes } from "./routes/topics.ts";
import type { Deps } from "./routes/types.ts";
import { createAuthServices } from "./services/auth/index.ts";
import type { OmeldarClient } from "./services/auth/omeldar.ts";
import { backupBeforeMigrate } from "./services/instance-backup.ts";
import { repairScopeConflicts } from "./services/labels.ts";
import { repairNameKeys } from "./services/name-keys.ts";
import type { ClaudeRunner } from "./services/ai.ts";
import { RESTORE_LIMITS, type RestoreLimits, recoverRestore } from "./services/restore.ts";
import { rebuildSearchIndex } from "./services/search-index.ts";

export const VERSION = packageJson.version;

export interface BuildOptions {
  config: Config;
  clock?: Clock;
  logger?: FastifyServerOptions["logger"];
  /** Smaller restore limits for tests. */
  limits?: Partial<RestoreLimits>;
  /** Stands in for the Claude API in tests. */
  claude?: ClaudeRunner;
  /** Stands in for auth.omeldar.com in tests. */
  omeldar?: OmeldarClient;
}

/**
 * Builds the HTTP app: opens the data dir and database (a copy of it first when a migration is due),
 * repairs derived data of every account, registers security, the API, docs and the local web app.
 */
export async function buildApp(options: BuildOptions) {
  const { config } = options;
  ensureDataDir(config.dataDir);
  const clock = options.clock ?? systemClock;
  const dbFile = join(config.dataDir, DB_FILE);
  backupBeforeMigrate(dbFile, ensurePrivateDir(config.backupDir), clock, config.timeZone);
  const db = openDb(dbFile);
  const auth = createAuthServices(
    config,
    config.secret ?? loadSecret(config.dataDir),
    clock,
    options.omeldar,
  );
  const filesDir = ensurePrivateDir(config.filesDir);
  // Before anything touches a files folder: finish or clean up interrupted restores.
  const recovered = recoverRestore({ dataDir: config.dataDir, filesDir }, db, clock());
  // Fills the case-free name keys and merges names of one account that differ only in case.
  const mergedNames = repairNameKeys(db.$client);
  // The index is derived data: rebuilding at every start heals it.
  rebuildSearchIndex(db);
  const deps: Deps = {
    db,
    clock,
    fallbackTimeZone: config.timeZone,
    version: VERSION,
    dataDir: config.dataDir,
    filesDir,
    backupDir: config.backupDir,
    filesLimitBytes: config.filesLimitBytes,
    limits: { ...RESTORE_LIMITS, ...options.limits },
    restoreLock: { busy: false },
  };

  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 1_048_576,
    routerOptions: { ignoreTrailingSlash: true },
    trustProxy: proxyMatcher(config.trustedProxies),
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("onClose", async () => db.$client.close());
  if (recovered > 0) app.log.warn(`finished the file swap of ${recovered} interrupted restores`);
  if (mergedNames > 0)
    app.log.warn(`merged ${mergedNames} labels, topics or person tags that differed only in case`);
  let repaired = 0;
  for (const { id } of db.select({ id: accounts.id }).from(accounts).all()) {
    repaired += repairScopeConflicts({ db, clock, timeZone: config.timeZone, accountId: id });
  }
  if (repaired > 0) app.log.warn(`removed duplicate scope labels from ${repaired} todos`);

  registerSecurity(app, { db, clock, auth });
  registerErrorHandling(app);

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "Sloppanizer API",
        version: VERSION,
        description:
          "Todos, notes and people, one account per caller. Auth: Authorization: Bearer <access token or " +
          "spz_ API token> (read tokens: GET only). Errors: { error: { code, message, details? } }.",
      },
      ...(config.publicUrl ? { servers: [{ url: config.publicUrl }] } : {}),
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
      security: [{ bearer: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(fastifySwaggerUi, { routePrefix: "/api/docs", staticCSP: false });
  app.get("/api/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  metaRoutes(app, deps);
  projectRoutes(app, deps);
  spaceRoutes(app, deps, auth.config);
  labelRoutes(app, deps);
  peopleRoutes(app, deps);
  peopleStatsRoutes(app, deps);
  topicRoutes(app, deps);
  notificationRoutes(app, deps);
  personTagRoutes(app, deps);
  todoRoutes(app, deps);
  todoRelationRoutes(app, deps);
  plannerRoutes(app, deps);
  blockSeriesRoutes(app, deps);
  commentRoutes(app, deps);
  noteRoutes(app, deps);
  meetingRoutes(app, deps);
  attachmentRoutes(app, deps);
  drawingRoutes(app, deps, auth);
  searchRoutes(app, deps);
  tokenRoutes(app, deps);
  exportRoutes(app, deps);
  settingsRoutes(app, deps);
  restoreRoutes(app, deps);
  mcpRoutes(app, deps);
  registerAccountApi(app, deps, auth);
  await oauthRoutes(app, deps, auth);
  calendarRoutes(app, deps, auth);
  aiRoutes(app, deps, auth, options.claude);
  await registerWeb(app, config.webDir);

  return { app, deps, auth };
}
