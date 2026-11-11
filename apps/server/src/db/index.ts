import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.ts";

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** Opens the database (WAL, foreign keys on) and applies pending migrations. */
export function openDb(file: string): Db {
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return db;
}

/** Number of applied migrations; written to export manifests. */
export function schemaVersion(db: Db): number {
  const row = db.$client.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number };
  return row.n;
}
