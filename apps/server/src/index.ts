import { buildApp } from "./app.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { SINGLE_USER_DATA_DIR } from "./db/index.ts";
import { LOG_REDACT } from "./http/security.ts";
import { Argon2MissingError, assertArgon2 } from "./services/auth/password.ts";
import { startScheduler } from "./services/jobs.ts";

function fail(message: string): never {
  console.error(`sloppanizer: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  let config;
  try {
    assertArgon2();
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError || error instanceof Argon2MissingError) fail(error.message);
    throw error;
  }
  let built;
  try {
    built = await buildApp({
      config,
      logger: {
        level: process.env.LOG_LEVEL ?? (config.production ? "info" : "debug"),
        redact: { paths: LOG_REDACT, censor: "[redacted]" },
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === SINGLE_USER_DATA_DIR) fail(error.message);
    throw error;
  }
  const { app, deps } = built;
  const stopJobs = startScheduler({
    db: deps.db,
    clock: deps.clock,
    config,
    version: deps.version,
    log: app.log,
  });

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} received, shutting down`);
    stopJobs();
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error({ err: error }, "shutdown failed");
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await app.listen({ port: config.port, host: config.host });
  const commit = (process.env.SLOPPANIZER_COMMIT ?? "").slice(0, 12);
  const build = commit && commit !== "unknown" ? ` (${commit})` : "";
  app.log.info(
    `Sloppanizer ${deps.version}${build}: data in ${config.dataDir}, backups in ${config.backupDir}`,
  );
}

await main();
