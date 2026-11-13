import type { Settings } from "@organizer/shared";
import { eq } from "drizzle-orm";
import { accountSettings } from "../db/schema.ts";
import { accountFilesBytes } from "./attachments.ts";
import type { Scoped } from "./context.ts";
import { owned } from "./owned.ts";

export const LAST_EXPORT_AT = "lastExportAt";

/** Settings of the scope's account (JSON values). */
export function getSetting<T>(sc: Scoped, key: string): T | null {
  const row = sc.db
    .select()
    .from(accountSettings)
    .where(owned(sc, accountSettings, eq(accountSettings.key, key)))
    .get();
  return row ? (JSON.parse(row.value) as T) : null;
}

export function setSetting(sc: Scoped, key: string, value: unknown): void {
  const json = JSON.stringify(value);
  sc.db
    .insert(accountSettings)
    .values({ accountId: sc.accountId, key, value: json })
    .onConflictDoUpdate({ target: [accountSettings.accountId, accountSettings.key], set: { value: json } })
    .run();
}

/** Settings of this server only: never exported, and kept when a restore replaces the account's data. */
export const LOCAL_SETTING_KEYS = ["restoreInProgress"] as const;

/** Keys of the single-user version that mean nothing per account; a restore drops them. */
export const OBSOLETE_SETTING_KEYS = ["lastFolderExport"] as const;

/** What the Settings page shows: the last export, the version and the account's files against its limit. */
export function getSettings(sc: Scoped, server: { version: string; filesLimitBytes: number }): Settings {
  return {
    lastExportAt: getSetting<string>(sc, LAST_EXPORT_AT),
    version: server.version,
    filesBytes: accountFilesBytes(sc),
    filesLimitBytes: server.filesLimitBytes,
  };
}
