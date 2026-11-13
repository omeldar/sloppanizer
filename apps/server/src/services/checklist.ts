import {
  type ChecklistStaleDetails,
  parseChecklist,
  setChecklistItem,
  type ToggleChecklist,
  type Todo,
} from "@organizer/shared";
import { eq } from "drizzle-orm";
import { todos } from "../db/schema.ts";
import { ApiError, notFound } from "../http/errors.ts";
import { type Ctx, inTx, now } from "./context.ts";
import { owned } from "./owned.ts";
import { recordEvents } from "./events.ts";
import { indexTodo } from "./search-index.ts";
import { getTodo } from "./todos.ts";

/**
 * Checks or unchecks one task list item in a todo's description. An unknown index, or a text that
 * differs from what the client saw, answers 409 with the current items. Records checklist_changed
 * (not a description edit) and bumps the activity time.
 */
export function toggleChecklist(ctx: Ctx, actor: string, id: number, input: ToggleChecklist): Todo {
  return ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    const row = tx
      .select()
      .from(todos)
      .where(owned(sc, todos, eq(todos.id, id)))
      .get();
    if (!row) throw notFound("Todo", id);
    const items = parseChecklist(row.descriptionMd);
    const item = items[input.index];
    if (!item || (input.text !== undefined && input.text !== item.text)) {
      const details: ChecklistStaleDetails = { items };
      throw new ApiError("conflict", "The checklist changed. Reload and try again.", details);
    }
    if (item.checked !== input.checked) {
      const at = now(ctx);
      tx.update(todos)
        .set({
          descriptionMd: setChecklistItem(row.descriptionMd, input.index, input.checked),
          updatedAt: at,
          lastActivityAt: at,
        })
        .where(owned(sc, todos, eq(todos.id, id)))
        .run();
      indexTodo(sc, id);
      recordEvents(sc, actor, at, [
        { todoId: id, kind: "checklist_changed", data: { text: item.text, checked: input.checked } },
      ]);
    }
    return getTodo(sc, id);
  });
}
