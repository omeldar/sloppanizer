import { addDays, firstSeriesDate } from "@organizer/shared";
import { and, eq } from "drizzle-orm";
import { series } from "../db/schema.ts";
import type { Scoped } from "./context.ts";
import { owned } from "./owned.ts";
import { deleteSegment, dropExceptionsFrom, segmentsOfOwners, updateSegment } from "./series-editor.ts";

/**
 * The planned time of a repeating todo belongs to the open todo of the repeat. These keep it there when
 * todos.ts makes the next todo or takes it back, and end it when the repeat stops.
 */

/** Hands the planned time from one todo of a repeat to another (next made, or an untouched next undone). */
export function moveRepeatPlan(sc: Scoped, fromTodoId: number, toTodoId: number, at: string): void {
  sc.db
    .update(series)
    .set({ todoId: toTodoId, updatedAt: at })
    .where(owned(sc, series, and(eq(series.ownerKind, "todo"), eq(series.todoId, fromTodoId))))
    .run();
}

/**
 * The repeat stopped (no repeat any more, or none on a schedule, or past its last date): the planned
 * time ends today. Past dates stay as history; parts that start later go.
 */
export function endRepeatPlan(sc: Scoped, todoId: number, today: string, at: string): void {
  for (const segment of segmentsOfOwners(sc, "todo", [todoId]).get(todoId) ?? []) {
    if (segment.endsOn !== null && segment.endsOn <= today) continue;
    const { id, ...span } = segment;
    const ended = { ...span, endsOn: today };
    if (segment.startsOn > today || firstSeriesDate(ended) === null) {
      deleteSegment(sc, id);
      continue;
    }
    updateSegment(sc, id, ended, at);
    dropExceptionsFrom(sc, id, addDays(today, 1));
  }
}
