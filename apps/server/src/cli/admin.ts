import { join } from "node:path";
import packageJson from "../../package.json" with { type: "json" };
import { type Clock, systemClock } from "../clock.ts";
import { type Config, ConfigError, loadConfig } from "../config.ts";
import { DB_FILE, ensureDataDir } from "../data-dir.ts";
import { type Db, openDb } from "../db/index.ts";
import { ApiError } from "../http/errors.ts";
import { findAccount } from "../services/accounts.ts";
import {
  type Actor,
  disableAccount,
  enableAccount,
  listAccounts,
  makeAdmin,
  resetAccountLogin,
  unlockAccount,
} from "../services/auth/admin.ts";
import { adminExists, prepareSetupCode } from "../services/auth/instance.ts";
import { createInstanceBackup } from "../services/instance-backup.ts";

const USAGE = `Usage: node src/cli/admin.ts <command>
  accounts                 list accounts (metadata only)
  reset-login <username>   clear the login and print a reset code (24 hours)
  unlock <username>        lift a login lock
  disable <username>       disable an account (signs out every session)
  enable <username>        enable a disabled account
  make-admin <username>    make an active account admin (emergency)
  setup-code               print a new first-admin setup code (only while no admin exists)
  backup                   write a whole-instance backup into the backups folder`;

/**
 * The admin CLI inside the container (`docker exec sloppanizer node src/cli/admin.ts ...`). It works on
 * metadata and logins only: no command shows or exports account contents, and none makes tokens or
 * sessions. Every change is logged with actor "cli".
 */
export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  clock: Clock = systemClock,
): Promise<number> {
  const [command, username, ...rest] = argv;
  const needsName = ["reset-login", "unlock", "disable", "enable", "make-admin"];
  const known = [...needsName, "accounts", "setup-code", "backup"];
  if (
    !command ||
    !known.includes(command) ||
    rest.length > 0 ||
    needsName.includes(command) !== Boolean(username)
  ) {
    console.error(USAGE);
    return 2;
  }
  let config: Config;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
  ensureDataDir(config.dataDir);
  const db = openDb(join(config.dataDir, DB_FILE));
  try {
    return await run(db, config, clock, command, username?.trim().toLowerCase());
  } catch (error) {
    if (error instanceof ApiError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  } finally {
    db.$client.close();
  }
}

const CLI: Actor = { name: "cli", accountId: null };

async function run(
  db: Db,
  config: Config,
  clock: Clock,
  command: string,
  username?: string,
): Promise<number> {
  const nowMs = clock().getTime();
  const idOf = (name: string): number => {
    const row = findAccount(db, name);
    if (!row) throw new ApiError("not_found", `There is no account ${name}.`);
    return row.id;
  };
  switch (command) {
    case "accounts": {
      const rows = listAccounts(db, nowMs);
      const lines = rows.map((a) =>
        [
          a.username.padEnd(32),
          a.status.padEnd(8),
          a.role.padEnd(5),
          `last login ${a.lastLoginAt ?? "never"}`,
          a.lockedUntil ? `locked until ${a.lockedUntil}` : "",
          a.resetPending ? "reset open" : "",
        ]
          .filter(Boolean)
          .join("  "),
      );
      console.log(lines.length > 0 ? lines.join("\n") : "No accounts yet.");
      return 0;
    }
    case "reset-login": {
      const { resetCode, expiresAt } = resetAccountLogin(db, nowMs, CLI, idOf(username as string));
      console.log(`Reset code for ${username}: ${resetCode}`);
      console.log(`It works once, until ${expiresAt}. The person opens /reset with it.`);
      return 0;
    }
    case "unlock":
      unlockAccount(db, nowMs, CLI, idOf(username as string));
      console.log(`Unlocked ${username}.`);
      return 0;
    case "disable":
      disableAccount(db, nowMs, CLI, idOf(username as string));
      console.log(`Disabled ${username}; every session of it is signed out.`);
      return 0;
    case "enable":
      enableAccount(db, nowMs, CLI, idOf(username as string));
      console.log(`Enabled ${username}.`);
      return 0;
    case "make-admin":
      makeAdmin(db, nowMs, CLI, username as string);
      console.log(`${username} is an admin now.`);
      return 0;
    case "setup-code": {
      if (adminExists(db)) {
        console.error("An admin account exists already; setup codes are only for the first admin.");
        return 1;
      }
      const code = db.transaction((tx) => prepareSetupCode(tx, config.setupCode));
      if (code === null) {
        console.error("The setup code is fixed by SLOPPANIZER_SETUP_CODE.");
        return 1;
      }
      console.log(`New setup code (the old one stops working): ${code}`);
      return 0;
    }
    case "backup": {
      const backup = await createInstanceBackup({
        db,
        clock,
        backupDir: config.backupDir,
        filesDir: config.filesDir,
        keep: config.backupKeep,
        version: packageJson.version,
        timeZone: config.timeZone,
        actor: "cli",
      });
      console.log(`Wrote ${join(config.backupDir, "instance", backup.fileName)} (${backup.bytes} bytes).`);
      return 0;
    }
    default:
      return 2;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
