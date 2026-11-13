import type { CreateSubtasks, Todo } from "@organizer/shared";
import { eq } from "drizzle-orm";
import { todos } from "../db/schema.ts";
import { notFound } from "../http/errors.ts";
import { type Ctx, inTx, now } from "./context.ts";
import { owned } from "./owned.ts";
import { recordEvents } from "./events.ts";
import { assertCanBeParent, nextChildPosition } from "./hierarchy.ts";
import { insertTodo } from "./todos.ts";

/**
 * Creates subtasks under a todo in the given order: positions after the last child, the parent's
 * project, one transaction and one subtasks_changed event on the parent.
 */
export function createSubtasks(ctx: Ctx, actor: string, parentId: number, input: CreateSubtasks): Todo[] {
  return ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    const parent = tx
      .select()
      .from(todos)
      .where(owned(sc, todos, eq(todos.id, parentId)))
      .get();
    if (!parent) throw notFound("Todo", parentId);
    assertCanBeParent(sc, null, parentId);
    const at = now(ctx);
    const start = nextChildPosition(sc, parentId);
    const created = input.titles.map((title, i) =>
      insertTodo(sc, at, actor, { title, projectId: parent.projectId }, { parentId, position: start + i }),
    );
    tx.update(todos)
      .set({ updatedAt: at, lastActivityAt: at })
      .where(owned(sc, todos, eq(todos.id, parentId)))
      .run();
    recordEvents(sc, actor, at, [
      {
        todoId: parentId,
        kind: "subtasks_changed",
        data: { added: created.map((t) => ({ id: t.id, title: t.title })), removed: [] },
      },
    ]);
    return created;
  });
}
