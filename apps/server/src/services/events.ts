import type { EventKind } from "@organizer/shared";
import { events } from "../db/schema.ts";
import type { Tx } from "./context.ts";

export interface EventInput {
  todoId: number;
  kind: EventKind;
  data: unknown;
}

/** Records todo history (who changed what, from and to). */
export function recordEvents(db: Tx, actor: string, at: string, list: readonly EventInput[]): void {
  if (list.length === 0) return;
  db.insert(events)
    .values(
      list.map((e) => ({
        todoId: e.todoId,
        actor,
        kind: e.kind,
        data: JSON.stringify(e.data),
        createdAt: at,
      })),
    )
    .run();
}
