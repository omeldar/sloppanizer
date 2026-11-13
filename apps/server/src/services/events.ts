import type { EventKind } from "@organizer/shared";
import { events } from "../db/schema.ts";
import type { Scoped } from "./context.ts";
import { insertOwned } from "./owned.ts";

export interface EventInput {
  todoId: number;
  kind: EventKind;
  data: unknown;
}

/** Records todo history (who changed what, from and to). */
export function recordEvents(sc: Scoped, actor: string, at: string, list: readonly EventInput[]): void {
  insertOwned(
    sc,
    events,
    list.map((e) => ({
      todoId: e.todoId,
      actor,
      kind: e.kind,
      data: JSON.stringify(e.data),
      createdAt: at,
    })),
  );
}
