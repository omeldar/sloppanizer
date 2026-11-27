import type { BulkPatch, Todo } from "@organizer/shared";
import { useCallback } from "react";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import { errorMessage } from "../../lib/api.ts";
import { useBulkUpdate } from "../../lib/queries.ts";

/** The server takes at most this many ids per bulk call. */
export const BULK_MAX = 200;

export interface BulkCall {
  ids: number[];
  patch: BulkPatch;
}

/** Splits ids into calls the server accepts (200 each). */
export function chunked(ids: readonly number[], patch: BulkPatch): BulkCall[] {
  const calls: BulkCall[] = [];
  for (let i = 0; i < ids.length; i += BULK_MAX) calls.push({ ids: ids.slice(i, i + BULK_MAX), patch });
  return calls;
}

const people = (list: Todo["requestedBy"]) => list.map((p) => ({ personId: p.id }));

/** What puts one todo back to how it was before the patch: only the fields the patch touched. */
export function inversePatch(todo: Todo, patch: BulkPatch): BulkPatch {
  const back: BulkPatch = {};
  if (patch.status !== undefined) back.status = todo.status;
  if (patch.projectId !== undefined) back.projectId = todo.projectId;
  if (patch.dueOn !== undefined) back.dueOn = todo.dueOn;
  if (patch.plannedOn !== undefined) back.plannedOn = todo.plannedOn;
  if (patch.labels !== undefined || patch.addLabels !== undefined || patch.removeLabels !== undefined) {
    back.labels = todo.labels.map((l) => l.name);
  }
  if (
    patch.requestedBy !== undefined ||
    patch.addRequestedBy !== undefined ||
    patch.removeRequestedBy !== undefined
  ) {
    back.requestedBy = people(todo.requestedBy);
  }
  if (patch.contacts !== undefined || patch.addContacts !== undefined || patch.removeContacts !== undefined) {
    back.contacts = people(todo.contacts);
  }
  if (patch.assignee !== undefined) back.assignee = todo.assignee?.username ?? null;
  return back;
}

/** The undo of a bulk change: todos that go back the same way share one call. */
export function undoCalls(before: readonly Todo[], patch: BulkPatch): BulkCall[] {
  const groups = new Map<string, { ids: number[]; patch: BulkPatch }>();
  for (const todo of before) {
    const back = inversePatch(todo, patch);
    const key = JSON.stringify(back);
    const group = groups.get(key) ?? { ids: [], patch: back };
    group.ids.push(todo.id);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap((group) => chunked(group.ids, group.patch));
}

/**
 * One change to many todos from a list's selection: one bulk call (more past 200 todos), then a toast
 * that says what changed, with an undo that puts each todo back as it was.
 */
export function useBulkActions() {
  const { mutateAsync } = useBulkUpdate();
  const toast = useToast();

  const send = useCallback(
    async (calls: readonly BulkCall[]) => {
      // One after the other: a later call can rely on an earlier one (the person it created).
      for (const call of calls) {
        // oxlint-disable-next-line no-await-in-loop -- in order, see above
        await mutateAsync(call);
      }
    },
    [mutateAsync],
  );

  /** Resolves true when the change was saved. */
  const apply = useCallback(
    async (todos: readonly Todo[], patch: BulkPatch, message: string): Promise<boolean> => {
      if (todos.length === 0) return false;
      try {
        await send(
          chunked(
            todos.map((t) => t.id),
            patch,
          ),
        );
      } catch (error) {
        toast.show({ tone: "error", message: `Could not change the todos. ${errorMessage(error)}` });
        return false;
      }
      const undo = undoCalls(todos, patch);
      toast.show({
        message,
        action: {
          label: "Undo",
          run: () =>
            void send(undo).catch((error: unknown) =>
              toast.show({ tone: "error", message: `Could not undo it. ${errorMessage(error)}` }),
            ),
        },
      });
      return true;
    },
    [send, toast],
  );

  return { apply };
}

/** "1 todo", "4 todos". */
export const todoCount = (n: number) => `${n} ${n === 1 ? "todo" : "todos"}`;
