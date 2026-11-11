import { buildApp } from "./app.ts";
import { ConfigError, loadConfig } from "./config.ts";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`organizer: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
  const { app } = await buildApp({
    config,
    logger: { level: process.env.LOG_LEVEL ?? (config.production ? "info" : "debug") },
  });

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} received, shutting down`);
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
  app.log.info(`organizer ${config.dataDir} (time zone ${config.timeZone})`);
}

await main();
