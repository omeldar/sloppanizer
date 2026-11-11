import { TokenScope } from "@organizer/shared";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { systemClock } from "../clock.ts";
import { loadConfig } from "../config.ts";
import { DB_FILE, ensureDataDir, writePrivateFile } from "../data-dir.ts";
import { openDb } from "../db/index.ts";
import { createToken } from "../services/tokens.ts";

const USAGE = "Usage: token:create --name <name> --scope read|write [--out <file>]";

/**
 * Creates an API token in the data dir's database. With --out the raw token goes to that file (0600)
 * and nothing secret is printed; without it the raw token is printed once.
 */
export function main(argv: string[]): number {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { name: { type: "string" }, scope: { type: "string" }, out: { type: "string" } },
      strict: true,
    }));
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  const name = values.name?.trim();
  const scope = TokenScope.safeParse(values.scope);
  if (!name || !scope.success) {
    console.error(USAGE);
    return 2;
  }
  const config = loadConfig();
  ensureDataDir(config.dataDir);
  const db = openDb(join(config.dataDir, DB_FILE));
  try {
    const { token, raw } = createToken(db, systemClock, { name, scope: scope.data });
    if (values.out) {
      writePrivateFile(values.out, `${raw}\n`);
      console.log(
        `Created ${token.scope} token "${token.name}" (${token.prefix}...), written to ${values.out}.`,
      );
    } else {
      console.log(raw);
    }
  } finally {
    db.$client.close();
  }
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
