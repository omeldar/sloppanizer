import type { FastifyBaseLogger } from "fastify";
import type { Clock } from "../clock.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { expireSignups } from "./auth/admin.ts";
import { pruneAdminEvents } from "./auth/instance.ts";
import { pruneSessions } from "./auth/sessions.ts";
import { pruneThrottle } from "./auth/throttle.ts";
import { createInstanceBackup, nextBackupAt } from "./instance-backup.ts";
import { cleanStaged } from "./restore.ts";

/**
 * Background jobs. The job functions take the clock, so tests run them directly; only index.ts starts
 * the timers (buildApp does not, so tests never have stray timers).
 */

export interface JobDeps {
  db: Db;
  clock: Clock;
  config: Config;
  version: string;
  log: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
}

export interface HourlyResult {
  expiredSignups: number;
  prunedSessions: number;
  prunedThrottle: number;
  prunedEvents: number;
}

/** Expire pending sign-ups, delete old sessions, prune login throttle rows and the admin log, clean staged restores. */
export function runHourlyJobs(deps: Pick<JobDeps, "db" | "clock" | "config">): HourlyResult {
  const now = deps.clock();
  const nowMs = now.getTime();
  const result = {
    expiredSignups: expireSignups(deps.db, nowMs),
    prunedSessions: deps.db.transaction((tx) => pruneSessions(tx, nowMs)),
    prunedThrottle: deps.db.transaction((tx) => pruneThrottle(tx, nowMs)),
    prunedEvents: deps.db.transaction((tx) => pruneAdminEvents(tx)),
  };
  cleanStaged(deps.config.dataDir, now);
  return result;
}

export async function runDailyBackup(deps: JobDeps): Promise<void> {
  const backup = await createInstanceBackup({
    db: deps.db,
    clock: deps.clock,
    backupDir: deps.config.backupDir,
    filesDir: deps.config.filesDir,
    keep: deps.config.backupKeep,
    version: deps.version,
    timeZone: deps.config.timeZone,
    actor: "system",
  });
  deps.log.info({ fileName: backup.fileName, bytes: backup.bytes }, "instance backup written");
}

const HOUR_MS = 3_600_000;

/** Starts the hourly jobs and the daily backup; returns a stop function. Timers do not keep the process alive. */
export function startScheduler(deps: JobDeps): () => void {
  const guard = (name: string, run: () => unknown) => {
    try {
      const result = run();
      if (result instanceof Promise) {
        result.catch((error: unknown) => deps.log.error({ err: error }, `${name} failed`));
      }
    } catch (error) {
      deps.log.error({ err: error }, `${name} failed`);
    }
  };
  guard("hourly jobs", () => runHourlyJobs(deps));
  const hourly = setInterval(() => guard("hourly jobs", () => runHourlyJobs(deps)), HOUR_MS);
  hourly.unref();

  let daily: NodeJS.Timeout | null = null;
  const planBackup = () => {
    const next = nextBackupAt(deps.clock().getTime(), deps.config.backupAt, deps.config.timeZone);
    if (!next) return;
    // setTimeout holds at most ~24.8 days; the next run is at most two days away.
    daily = setTimeout(
      () => {
        guard("daily backup", () => runDailyBackup(deps).finally(planBackup));
      },
      Math.max(1000, next.getTime() - deps.clock().getTime()),
    );
    daily.unref();
  };
  planBackup();
  return () => {
    clearInterval(hourly);
    if (daily) clearTimeout(daily);
  };
}
