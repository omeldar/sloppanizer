import { eq } from "drizzle-orm";
import { settings } from "../db/schema.ts";
import type { Tx } from "./context.ts";

export function getSetting<T>(db: Tx, key: string): T | null {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return row ? (JSON.parse(row.value) as T) : null;
}

export function setSetting(db: Tx, key: string, value: unknown): void {
  const json = JSON.stringify(value);
  db.insert(settings)
    .values({ key, value: json })
    .onConflictDoUpdate({ target: settings.key, set: { value: json } })
    .run();
}
