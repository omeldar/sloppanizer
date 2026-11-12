import type { TokenScope } from "@organizer/shared";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/index.ts";

/** What every service needs: the database, the clock and the user's time zone. */
export interface Ctx {
  db: Db;
  clock: Clock;
  timeZone: string;
}

/** A database handle inside or outside a transaction. */
export type Tx = Pick<Db, "select" | "insert" | "update" | "delete" | "run" | "all" | "get">;

export const now = (ctx: Pick<Ctx, "clock">): string => ctx.clock().toISOString();

/** Who is acting: the browser session ("you", write) or an API token (its name and scope). */
export interface Auth {
  actor: string;
  via: "session" | "token";
  scope: TokenScope;
}
