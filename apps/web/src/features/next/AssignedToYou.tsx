import type { Todo, TodoStatus } from "@organizer/shared";
import { StripRow } from "../../components/strip/StripRow.tsx";
import stripStyles from "../../components/strip/Strip.module.css";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import { useCurrentAccount } from "../../app/account.tsx";
import { errorMessage } from "../../lib/api.ts";
import { sharedTodoHref, useAssignedToMe, useSetSharedStatus } from "../../lib/spaces.ts";

/**
 * Next up in your own tab: the open todos assigned to you in shared projects, ranked like the rest,
 * each with the project it comes from. A title opens the todo in that project's tab, where every change
 * is made; the round done button marks it done right here (in the project, with undo).
 */
export function AssignedToYou() {
  const { items } = useAssignedToMe();
  const account = useCurrentAccount();
  const setStatus = useSetSharedStatus();
  const toast = useToast();
  if (items.length === 0 || !account) return null;

  const change = async (spaceId: number, todo: Todo, status: TodoStatus): Promise<boolean> => {
    try {
      await setStatus.mutateAsync({ spaceId, todoId: todo.id, status });
      return true;
    } catch (error) {
      toast.show({ tone: "error", message: `Could not change "${todo.title}". ${errorMessage(error)}` });
      return false;
    }
  };

  const toggle = async (spaceId: number, todo: Todo) => {
    const previous = todo.status;
    const next: TodoStatus = previous === "done" ? "open" : "done";
    if (!(await change(spaceId, todo, next))) return;
    toast.show({
      message: next === "done" ? `Marked "${todo.title}" done` : `Reopened "${todo.title}"`,
      action: { label: "Undo", run: () => void change(spaceId, todo, previous) },
    });
  };

  return (
    <section className={stripStyles.groupLead} aria-label="Assigned to you">
      <h2 className={stripStyles.groupTitle}>
        Assigned to you <span className={stripStyles.groupCount}>{items.length}</span>
      </h2>
      <ol className={stripStyles.bay} aria-label="Todos assigned to you in shared projects">
        {items.map(({ space, item }) => (
          <StripRow
            key={`${space.id}-${item.todo.id}`}
            todo={item.todo}
            reasons={item.reasons}
            score={item.score}
            collapseOnDone
            source={{
              name: space.name,
              color: space.color,
              href: sharedTodoHref(account.username, space.id, item.todo.id),
            }}
            onToggleDone={(todo) => void toggle(space.id, todo)}
          />
        ))}
      </ol>
    </section>
  );
}
