import { DisplayName, Password, TotpSecret, Username } from "@organizer/shared";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { systemClock } from "../clock.ts";
import { ConfigError, loadConfig } from "../config.ts";
import { DB_FILE, ensureDataDir } from "../data-dir.ts";
import { openDb } from "../db/index.ts";
import { findAccount, insertAccount, replaceRecoveryCodes } from "../services/accounts.ts";
import { loadDataKey } from "../services/auth/crypto.ts";
import { hashPassword } from "../services/auth/password.ts";
import { totpStep } from "../services/auth/totp.ts";
import { seedAccount } from "../services/owned.ts";

const USAGE =
  "Usage: node src/cli/dev-account.ts <username> --password-file <file> --totp-secret <32 base32> " +
  "[--display-name <name>] [--admin] [--time-zone <zone>]";

/**
 * Makes an active, seeded account for local development and tests (no sign-up, no approval). The
 * password comes from a file so it does not end up in the shell history. Refuses to run in production:
 * there accounts sign up and are approved, or the first admin uses the setup code.
 */
export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (env.NODE_ENV === "production") {
    console.error("dev-account is for development only; it refuses to run with NODE_ENV=production.");
    return 2;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        "password-file": { type: "string" },
        "totp-secret": { type: "string" },
        "display-name": { type: "string" },
        "time-zone": { type: "string" },
        admin: { type: "boolean" },
      },
      strict: true,
    });
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const username = Username.safeParse(positionals[0] ?? "");
  const secret = TotpSecret.safeParse(values["totp-secret"]);
  if (positionals.length !== 1 || !username.success || !secret.success || !values["password-file"]) {
    console.error(USAGE);
    return 2;
  }
  const password = readFileSync(values["password-file"], "utf8").replace(/\r?\n$/, "");
  const strong = Password.safeParse(password);
  if (!strong.success) {
    console.error(`The password is not accepted: ${strong.error.issues[0]?.message ?? "invalid"}`);
    return 2;
  }
  const displayName = DisplayName.safeParse(values["display-name"] ?? username.data);
  if (!displayName.success) {
    console.error(USAGE);
    return 2;
  }

  let config;
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
  const dataKey = loadDataKey(config.dataDir, config.dataKey);
  const passwordHash = await hashPassword(password);
  const db = openDb(join(config.dataDir, DB_FILE));
  try {
    if (findAccount(db, username.data)) {
      console.error(`The account ${username.data} exists already.`);
      return 2;
    }
    const now = systemClock();
    const nowIso = now.toISOString();
    const account = db.transaction((tx) => {
      const row = insertAccount(tx, dataKey, nowIso, {
        username: username.data,
        displayName: displayName.data,
        timeZone: values["time-zone"] ?? config.timeZone,
        status: "active",
        role: values.admin ? "admin" : "user",
        passwordHash,
        totpSecret: secret.data,
        // The code of the current step is still accepted once.
        totpStep: totpStep(now.getTime()) - 2,
      });
      seedAccount(tx, row.id, nowIso);
      replaceRecoveryCodes(tx, row.id, nowIso);
      return row;
    });
    console.log(`Created ${account.role} account ${account.username} (id ${account.id}).`);
  } finally {
    db.$client.close();
  }
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
