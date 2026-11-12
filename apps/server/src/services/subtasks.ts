import type { CreateSubtasks, Todo } from "@organizer/shared";
import { eq, max } from "drizzle-orm";
import { todos } from "../db/schema.ts";
import { notFound } from "../http/errors.ts";
import { type Ctx, now } from "./context.ts";
import { recordEvents } from "./events.ts";
import { assertCanBeParent } from "./hierarchy.ts";
import { insertTodo } from "./todos.ts";

/**
 * Creates subtasks under a todo in the given order: positions after the last child, the parent's
 * project, one transaction and one subtasks_changed event on the parent.
 */
export function createSubtasks(ctx: Ctx, actor: string, parentId: number, input: CreateSubtasks): Todo[] {
  return ctx.db.transaction((tx) => {
    const parent = tx.select().from(todos).where(eq(todos.id, parentId)).get();
    if (!parent) throw notFound("Todo", parentId);
    assertCanBeParent(tx, null, parentId);
    const at = now(ctx);
    const last = tx
      .select({ p: max(todos.position) })
      .from(todos)
      .where(eq(todos.parentId, parentId))
      .get();
    const start = last?.p === null || last?.p === undefined ? 0 : last.p + 1;
    const created = input.titles.map((title, i) =>
      insertTodo(tx, at, actor, { title, projectId: parent.projectId }, { parentId, position: start + i }),
    );
    tx.update(todos).set({ updatedAt: at, lastActivityAt: at }).where(eq(todos.id, parentId)).run();
    recordEvents(tx, actor, at, [
      {
        todoId: parentId,
        kind: "subtasks_changed",
        data: { added: created.map((t) => ({ id: t.id, title: t.title })), removed: [] },
      },
    ]);
    return created;
  });
}
