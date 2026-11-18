import { type MeetingTodo, STATUS_LABELS } from "@organizer/shared";
import { Link } from "@tanstack/react-router";
import { type CSSProperties, useState } from "react";
import { Dialog } from "../../components/Dialog.tsx";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import { Button, ErrorState, Loading } from "../../components/ui.tsx";
import { errorMessage } from "../../lib/api.ts";
import { dayLabel, dueText } from "../../lib/format.ts";
import {
  useAddMeetingTodo,
  useDueAtNextMeeting,
  useMeetingTodos,
  useRemoveMeetingTodo,
} from "../../lib/meetings.ts";
import { TodoSearchPicker } from "../todos/relations/TodoSearchPicker.tsx";
import styles from "./Meetings.module.css";

/** The label of the button that sets the due date, "Due at next meeting (Thu 26.11.)". */
export const dueAtNextLabel = (nextOn: string): string => `Due at next meeting (${dayLabel(nextOn)})`;

/**
 * The todos added to a meeting by hand: the same on every date until removed. On a standup they are
 * their own group under the worked-out list. A todo search adds one; each row can take the meeting's
 * next date as due date.
 */
export function MeetingTodos({ meetingId, meetingName }: { meetingId: number; meetingName: string }) {
  const list = useMeetingTodos(meetingId);
  const [adding, setAdding] = useState(false);
  // The actions live here, not in the rows: a removed row unmounts before its toast would show.
  const remove = useRemoveMeetingTodo();
  const add = useAddMeetingTodo();
  const due = useDueAtNextMeeting();
  const toast = useToast();
  const failed = (failure: unknown) => toast.show({ tone: "error", message: errorMessage(failure) });
  const actions: RowActions = {
    busy: remove.isPending || due.isPending,
    setDue: async (item, nextOn) => {
      try {
        await due.mutateAsync({ meetingId, todoId: item.todo.id });
        toast.show({ message: `"${item.todo.title}" is due ${dayLabel(nextOn)}` });
      } catch (failure) {
        failed(failure);
      }
    },
    remove: async (item) => {
      const vars = { meetingId, todoId: item.todo.id };
      try {
        await remove.mutateAsync(vars);
        toast.show({
          message: `Removed "${item.todo.title}" from this meeting`,
          action: { label: "Undo", run: () => add.mutate(vars, { onError: failed }) },
        });
      } catch (failure) {
        failed(failure);
      }
    },
  };
  return (
    <section className={styles.added} aria-labelledby="meeting-todos-title">
      <div className={styles.addedHead}>
        <h2 id="meeting-todos-title" className={styles.sectionTitle}>
          Todos on this meeting{" "}
          {list.data && list.data.items.length > 0 && (
            <span className={styles.groupCount}>{list.data.items.length}</span>
          )}
        </h2>
        <Button size="sm" onClick={() => setAdding(true)}>
          Add a todo
        </Button>
      </div>
      {list.isPending && <Loading label="Loading the todos of this meeting" />}
      {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
      {list.data && list.data.items.length === 0 && (
        <p className={styles.quiet}>
          Add todos you want to bring up. They stay here on every date until you remove them.
        </p>
      )}
      {list.data && list.data.items.length > 0 && (
        <ul className={styles.items}>
          {list.data.items.map((item) => (
            <Row key={item.todo.id} item={item} nextOn={list.data.nextOn} actions={actions} />
          ))}
        </ul>
      )}
      <AddTodoDialog
        meetingId={meetingId}
        meetingName={meetingName}
        exclude={list.data?.items.map((i) => i.todo.id) ?? []}
        open={adding}
        onOpenChange={setAdding}
      />
    </section>
  );
}

interface RowActions {
  busy: boolean;
  setDue: (item: MeetingTodo, nextOn: string) => Promise<void>;
  remove: (item: MeetingTodo) => Promise<void>;
}

function Row({ item, nextOn, actions }: { item: MeetingTodo; nextOn: string | null; actions: RowActions }) {
  const dueAtNext = nextOn !== null && item.dueOn === nextOn;
  return (
    <li className={styles.item} data-done={item.todo.status === "done" || undefined}>
      <div className={styles.addedRow}>
        <Link to="/todos/$id" params={{ id: String(item.todo.id) }} className={styles.addedMain}>
          <span className={styles.itemTitle}>{item.todo.title}</span>
          <span className={styles.itemMeta}>
            <span className={styles.addedStatus} data-status={item.todo.status}>
              {STATUS_LABELS[item.todo.status]}
            </span>
            {item.project && (
              <span className={styles.project}>
                <span
                  className={styles.projectDot}
                  style={{ "--swatch": item.project.color } as CSSProperties}
                  aria-hidden="true"
                />
                {item.project.name}
              </span>
            )}
            {item.parent && <span>in {item.parent.title}</span>}
            {item.dueOn && (
              <span className={styles.at}>{dueAtNext ? "Due at next meeting" : dueText(item.dueOn)}</span>
            )}
          </span>
        </Link>
        <div className={styles.addedActions}>
          {nextOn !== null && !dueAtNext && (
            <Button size="sm" disabled={actions.busy} onClick={() => void actions.setDue(item, nextOn)}>
              {dueAtNextLabel(nextOn)}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Remove "${item.todo.title}" from this meeting`}
            disabled={actions.busy}
            onClick={() => void actions.remove(item)}
          >
            Remove
          </Button>
        </div>
      </div>
    </li>
  );
}

function AddTodoDialog({
  meetingId,
  meetingName,
  exclude,
  open,
  onOpenChange,
}: {
  meetingId: number;
  meetingName: string;
  exclude: readonly number[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const add = useAddMeetingTodo();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const close = (next: boolean) => {
    setError(null);
    onOpenChange(next);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={`Add a todo to ${meetingName}`}
      width={560}
      placement="top"
    >
      {open && (
        <div className={styles.addDialog}>
          <TodoSearchPicker
            label="Todo"
            exclude={exclude}
            onPick={async (todo) => {
              setError(null);
              try {
                await add.mutateAsync({ meetingId, todoId: todo.id });
                toast.show({ message: `Added "${todo.title}" to ${meetingName}` });
                close(false);
              } catch (failure) {
                setError(errorMessage(failure));
              }
            }}
          />
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
