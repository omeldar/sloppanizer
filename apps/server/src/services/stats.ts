import { addDays, type Stats, startOfLocalDay, toLocalDate } from "@organizer/shared";
import { sql } from "drizzle-orm";
import { todos } from "../db/schema.ts";
import type { Ctx } from "./context.ts";
import { getSetting } from "./settings.ts";

export const LAST_EXPORT_AT = "lastExportAt";

/**
 * Counters for the status bar. Dates use the user's time zone. overdue, dueToday, plannedToday
 * and inbox count active todos only; plannedToday includes todos planned for an earlier day that
 * are still not done (the same rule as Next up). doneLast7Days = today and the 6 days before.
 */
export function stats(ctx: Ctx): Stats {
  const today = toLocalDate(ctx.clock(), ctx.timeZone);
  const weekStart = startOfLocalDay(addDays(today, -6), ctx.timeZone).toISOString();
  const active = sql`${todos.status} <> 'done'`;
  const row = ctx.db.get<Omit<Stats, "lastExportAt">>(sql`
    SELECT
      coalesce(sum(${todos.status} = 'open'), 0) AS open,
      coalesce(sum(${todos.status} = 'in_progress'), 0) AS inProgress,
      coalesce(sum(${todos.status} = 'blocked'), 0) AS blocked,
      coalesce(sum(${todos.status} = 'done' AND ${todos.doneAt} >= ${weekStart}), 0) AS doneLast7Days,
      coalesce(sum(${active} AND ${todos.dueOn} < ${today}), 0) AS overdue,
      coalesce(sum(${active} AND ${todos.dueOn} = ${today}), 0) AS dueToday,
      coalesce(sum(${active} AND ${todos.plannedOn} <= ${today}), 0) AS plannedToday,
      coalesce(sum(${active} AND ${todos.projectId} IS NULL), 0) AS inbox
    FROM ${todos}`);
  return { ...row, lastExportAt: getSetting<string>(ctx.db, LAST_EXPORT_AT) };
}
