import { SCHEMA_BASE } from "@organizer/shared";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import { registerTextFunctions } from "../services/sql.ts";
import * as authSchema from "./auth-schema.ts";
import * as userSchema from "./schema.ts";

const schema = { ...authSchema, ...userSchema };

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

export const SINGLE_USER_DATA_DIR =
  "This data dir comes from the single-user version. Start with an empty data dir and import the old " +
  "export zip into an account (Settings, Restore).";

/** A database file of the single-user organizer: user tables without account_id. */
function isSingleUserDatabase(sqlite: Database.Database): boolean {
  const todos = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'todos'").get();
  if (!todos) return false;
  const columns = sqlite.prepare("SELECT name FROM pragma_table_info('todos')").all() as { name: string }[];
  return !columns.some((c) => c.name === "account_id");
}

/**
 * Opens the database (WAL, foreign keys on, the text functions of services/sql.ts) and applies pending
 * migrations. Refuses a database of the single-user version (it cannot be migrated: the data goes in
 * through an export and a restore into an account).
 */
export function openDb(file: string): Db {
  const sqlite = new Database(file);
  if (isSingleUserDatabase(sqlite)) {
    sqlite.close();
    throw new Error(SINGLE_USER_DATA_DIR);
  }
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  registerTextFunctions(sqlite);
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return db;
}

/**
 * Schema version written to export manifests: SCHEMA_BASE (the single-user migrations) plus the applied
 * migrations, so the squashed baseline is 9 and every single-user export counts as older.
 */
export function schemaVersion(db: Db): number {
  const row = db.$client.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number };
  return SCHEMA_BASE + row.n;
}
