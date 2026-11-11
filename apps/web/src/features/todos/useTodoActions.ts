import {
  PRIORITY_SCOPE,
  type Priority,
  priorityOf,
  type Todo,
  type TodoStatus,
  type UpdateTodo,
} from "@organizer/shared";
import { useCallback } from "react";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import { errorMessage } from "../../lib/api.ts";
import { useUpdateTodo } from "../../lib/queries.ts";

type DoneTarget = Pick<Todo, "id" | "status">;

/** Todo changes shared by every list and the detail page; failures show as error toasts. */
export function useTodoActions() {
  const { mutateAsync } = useUpdateTodo();
  const toast = useToast();

  const update = useCallback(
    async (id: number, patch: UpdateTodo, failure: string): Promise<Todo | null> => {
      try {
        return await mutateAsync({ id, patch });
      } catch (error) {
        toast.show({ tone: "error", message: `${failure} ${errorMessage(error)}` });
        return null;
      }
    },
    [mutateAsync, toast],
  );

  /** Done <-> back to where it was, with an undo toast. */
  const toggleDone = useCallback(
    async (todo: DoneTarget) => {
      const previous: TodoStatus = todo.status;
      const marking = previous !== "done";
      const next: TodoStatus = marking ? "done" : "open";
      const saved = await update(
        todo.id,
        { status: next },
        marking ? `Could not mark #${todo.id} done.` : `Could not reopen #${todo.id}.`,
      );
      if (!saved) return;
      toast.show({
        message: marking ? `Marked #${todo.id} done` : `Reopened #${todo.id}`,
        action: {
          label: "Undo",
          run: () => void update(todo.id, { status: previous }, `Could not undo the change to #${todo.id}.`),
        },
      });
    },
    [update, toast],
  );

  /** Sets the priority label; the same priority again removes it. */
  const setPriority = useCallback(
    (todo: Pick<Todo, "id" | "labels">, priority: Priority) => {
      const name = `${PRIORITY_SCOPE}::${priority}`;
      const patch: UpdateTodo =
        priorityOf(todo.labels) === priority
          ? { removeLabels: todo.labels.filter((l) => l.name.toLowerCase() === name).map((l) => l.name) }
          : { addLabels: [name] };
      return update(todo.id, patch, `Could not change the priority of #${todo.id}.`);
    },
    [update],
  );

  const patch = useCallback(
    (id: number, change: UpdateTodo) => update(id, change, `Could not save #${id}.`),
    [update],
  );

  return { toggleDone, setPriority, patch };
}
