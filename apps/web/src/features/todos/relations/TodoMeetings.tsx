import type { Todo, TodoMeeting } from "@organizer/shared";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Dialog } from "../../../components/Dialog.tsx";
import { Picker, type PickerItem } from "../../../components/pickers/Picker.tsx";
import { useToast } from "../../../components/toast/ToastProvider.tsx";
import { Button } from "../../../components/ui.tsx";
import { errorMessage } from "../../../lib/api.ts";
import { dayLabel, toDate } from "../../../lib/format.ts";
import {
  useAddMeetingTodo,
  useDueAtNextMeeting,
  useMeetings,
  useRemoveMeetingTodo,
  useTodoMeetings,
} from "../../../lib/meetings.ts";
import { dueAtNextLabel } from "../../meetings/MeetingTodos.tsx";
import styles from "./Relations.module.css";

/** The meetings a todo was added to: open one, take its next date as due date, remove it, add another. */
export function TodoMeetings({ todo }: { todo: Todo }) {
  const meetings = useTodoMeetings(todo.id);
  const [adding, setAdding] = useState(false);
  // The actions live here, not in the rows: a removed row unmounts before its toast would show.
  const remove = useRemoveMeetingTodo();
  const due = useDueAtNextMeeting();
  const toast = useToast();
  const run = async (work: Promise<unknown>, message: string) => {
    try {
      await work;
      toast.show({ message });
    } catch (failure) {
      toast.show({ tone: "error", message: errorMessage(failure) });
    }
  };
  const list = meetings.data ?? [];
  return (
    <section className={styles.section} aria-labelledby={`todo-meetings-${todo.id}`}>
      <div className={styles.sectionHead}>
        <h2 id={`todo-meetings-${todo.id}`} className={styles.sectionTitle}>
          Meetings
        </h2>
        <Button size="sm" onClick={() => setAdding(true)}>
          Add to meeting
        </Button>
      </div>
      {list.length > 0 && (
        <ul className={styles.webLinks}>
          {list.map((entry) => (
            <Row
              key={entry.meeting.id}
              todo={todo}
              entry={entry}
              busy={remove.isPending || due.isPending}
              onDue={(nextOn) =>
                void run(
                  due.mutateAsync({ meetingId: entry.meeting.id, todoId: todo.id }),
                  `Due ${dayLabel(nextOn)}`,
                )
              }
              onRemove={() =>
                void run(
                  remove.mutateAsync({ meetingId: entry.meeting.id, todoId: todo.id }),
                  `Removed from ${entry.meeting.name}`,
                )
              }
            />
          ))}
        </ul>
      )}
      <AddToMeetingDialog
        todo={todo}
        on={list.map((m) => m.meeting.id)}
        open={adding}
        onOpenChange={setAdding}
      />
    </section>
  );
}

function Row({
  todo,
  entry,
  busy,
  onDue,
  onRemove,
}: {
  todo: Todo;
  entry: TodoMeeting;
  busy: boolean;
  onDue: (nextOn: string) => void;
  onRemove: () => void;
}) {
  const { nextOn } = entry;
  return (
    <li className={styles.meetingRow}>
      <Link to="/meetings/$id" params={{ id: String(entry.meeting.id) }} className={styles.webLinkMain}>
        <span className={styles.webLinkLabel}>{entry.meeting.name}</span>
        <span className={styles.webLinkHost}>
          {entry.meeting.type === "standup" ? "Standup" : "Other"},{" "}
          {nextOn === null ? "no next date" : `next ${dayLabel(nextOn)}`}
          {nextOn !== null && todo.dueOn === nextOn && ", due then"}
        </span>
      </Link>
      <div className={styles.meetingActions}>
        {nextOn !== null && todo.dueOn !== nextOn && (
          <Button size="sm" disabled={busy} onClick={() => onDue(nextOn)}>
            {dueAtNextLabel(nextOn)}
          </Button>
        )}
        <button
          type="button"
          className={styles.rowMenu}
          aria-label={`Remove from ${entry.meeting.name}`}
          disabled={busy}
          onClick={onRemove}
        >
          Remove
        </button>
      </div>
    </li>
  );
}

const NO_IDS: readonly number[] = [];

/** "Add to meeting": pick one of the account's meetings; the todo's due date stays. */
function AddToMeetingDialog({
  todo,
  on = NO_IDS,
  open,
  onOpenChange,
}: {
  todo: Todo;
  /** Meetings it is on already. */
  on?: readonly number[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const meetings = useMeetings();
  const add = useAddMeetingTodo();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const choices = (meetings.data ?? []).filter((m) => !on.includes(m.id));
  const items: PickerItem[] = choices.map((m) => ({
    value: String(m.id),
    label: m.name,
    search: m.name,
    note: m.next ? `next ${dayLabel(toDate(m.next.startAt))}` : "no next date",
  }));
  const close = (next: boolean) => {
    setError(null);
    onOpenChange(next);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={`Add #${todo.id} to a meeting`}
      width={440}
      placement="top"
    >
      {open && (
        <div className={styles.linkDialog}>
          <Picker
            label="Meeting"
            placeholder="Meeting name"
            items={items}
            selected={new Set()}
            onPick={async (value) => {
              const meeting = choices.find((m) => String(m.id) === value);
              if (!meeting) return;
              setError(null);
              try {
                await add.mutateAsync({ meetingId: meeting.id, todoId: todo.id });
                toast.show({ message: `Added to ${meeting.name}` });
                close(false);
              } catch (failure) {
                setError(errorMessage(failure));
              }
            }}
            empty={
              meetings.isPending
                ? "Loading the meetings…"
                : (meetings.data ?? []).length === 0
                  ? "No meetings yet. Create one under Meetings."
                  : choices.length === 0
                    ? "It is on every meeting already."
                    : "No meeting matches."
            }
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
