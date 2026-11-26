import type { AccountBrief, TokenScope } from "@organizer/shared";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/index.ts";

/**
 * What every service needs: the database, the clock, the account's time zone and the account every
 * query is scoped to. Services never read an account id from input, only from here.
 */
export interface Ctx {
  db: Db;
  clock: Clock;
  timeZone: string;
  accountId: number;
  /**
   * The caller's own user account (also inside a shared project, where accountId is the space's). Only
   * filters read it ("assigned to me"); left out by internal callers, where "me" matches nothing.
   */
  callerId?: number;
}

/** A database handle inside or outside a transaction. */
export type Tx = Pick<Db, "select" | "insert" | "update" | "delete" | "run" | "all" | "get">;

/** A database handle (also a transaction) plus the account the queries are scoped to. */
export interface Scoped {
  db: Tx;
  accountId: number;
}

/** The scope of a transaction opened by a service. */
export const inTx = (ctx: Pick<Ctx, "accountId">, tx: Tx): Scoped => ({ db: tx, accountId: ctx.accountId });

export const now = (ctx: Pick<Ctx, "clock">): string => ctx.clock().toISOString();

/** The calling account as the security hook loaded it (active, at the time of the request). */
export interface AuthAccount extends AccountBrief {
  timeZone: string;
}

/**
 * Who is acting: a signed-in browser session ("you", write; its session id and last full sign-in) or an
 * API token (its id, name and scope). Both belong to exactly one account.
 */
export type Auth = {
  accountId: number;
  account: AuthAccount;
  actor: string;
  scope: TokenScope;
  /**
   * Set inside a shared project: accountId is then the space's, account stays the member's own (its time
   * zone is used), actor is the member's name.
   */
  space?: { id: number; role: "owner" | "member"; memberId: number };
} & ({ via: "session"; sessionId: string; authenticatedAt: string } | { via: "token"; tokenId: number });
