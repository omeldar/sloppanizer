import { type TimeBlock, toLocalDate, toLocalTime } from "@organizer/shared";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Dialog } from "../../components/Dialog.tsx";
import { Button, Field, TextInput } from "../../components/ui.tsx";
import { errorMessage } from "../../lib/api.ts";
import { timeZone } from "../../lib/format.ts";
import { useCreateBlock, useDeleteBlock, useUpdateBlock } from "../../lib/queries.ts";
import { TodoSearchPicker } from "../todos/relations/TodoSearchPicker.tsx";
import styles from "./Planner.module.css";
import { blockSpan, lengthMinutes, minutesToTime, timeToMinutes } from "./planner.ts";

export interface BlockDraft {
  /** An existing block to edit, or none for a new one. */
  block?: TimeBlock;
  day: string;
  start: string;
  end: string;
  todo?: { id: number; title: string } | null;
}

/** Creates or edits one time block: for a todo (search) or with a title, a day, start and end. */
export function BlockDialog({ draft, onClose }: { draft: BlockDraft | null; onClose: () => void }) {
  return (
    <Dialog
      open={draft !== null}
      onOpenChange={(open) => !open && onClose()}
      title={draft?.block ? "Planned time" : "Plan time"}
      width={460}
    >
      {draft && (
        <BlockForm key={draft.block?.id ?? `${draft.day}-${draft.start}`} draft={draft} onClose={onClose} />
      )}
    </Dialog>
  );
}

const DURATIONS = [30, 60, 90, 120, 180] as const;

function BlockForm({ draft, onClose }: { draft: BlockDraft; onClose: () => void }) {
  const create = useCreateBlock();
  const update = useUpdateBlock();
  const remove = useDeleteBlock();
  const [todo, setTodo] = useState(draft.todo ?? null);
  const [title, setTitle] = useState(draft.block?.title ?? "");
  const [day, setDay] = useState(draft.day);
  const [start, setStart] = useState(draft.start);
  // A time field cannot show 24:00: midnight at the end is 00:00, which blockSpan reads as the next day.
  const [end, setEnd] = useState(draft.end === "24:00" ? "00:00" : draft.end);
  const [error, setError] = useState<string | null>(null);
  const busy = create.isPending || update.isPending || remove.isPending;

  // Late blocks may run past midnight into the next day.
  const setLength = (minutes: number) => setEnd(minutesToTime((timeToMinutes(start) + minutes) % (24 * 60)));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!todo && title.trim() === "") {
      setError("Pick a todo or give the block a title.");
      return;
    }
    const span = blockSpan(day, start, end, timeZone);
    const body = { todoId: todo?.id ?? null, title: todo ? "" : title.trim(), ...span };
    const done = { onSuccess: onClose, onError: (failure: unknown) => setError(errorMessage(failure)) };
    if (draft.block) update.mutate({ id: draft.block.id, patch: body }, done);
    else create.mutate(body, done);
  };

  return (
    <form className={styles.form} onSubmit={submit}>
      {todo ? (
        <div className={styles.picked}>
          <span className={styles.pickedLabel}>For</span>
          <Link
            to="/todos/$id"
            params={{ id: String(todo.id) }}
            className={styles.pickedTitle}
            onClick={onClose}
          >
            #{todo.id} {todo.title}
          </Link>
          <Button size="sm" variant="ghost" onClick={() => setTodo(null)}>
            Change
          </Button>
        </div>
      ) : (
        <>
          <TodoSearchPicker
            label="Todo"
            onPick={(picked) => setTodo({ id: picked.id, title: picked.title })}
          />
          <Field label="Or a title">
            <TextInput
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Focus time, gym, call with Bo"
              maxLength={200}
            />
          </Field>
        </>
      )}
      <div className={styles.timeRow}>
        <Field label="Day">
          <TextInput type="date" value={day} onChange={(event) => setDay(event.target.value)} required />
        </Field>
        <Field label="From">
          <TextInput
            type="time"
            step={900}
            value={start}
            onChange={(event) => setStart(event.target.value)}
            required
          />
        </Field>
        <Field label="To">
          <TextInput
            type="time"
            step={900}
            value={end}
            onChange={(event) => setEnd(event.target.value)}
            required
          />
        </Field>
      </div>
      <div className={styles.lengths} role="group" aria-label="Length">
        {DURATIONS.map((minutes) => (
          <button
            key={minutes}
            type="button"
            className={styles.length}
            data-on={lengthMinutes(start, end) === minutes || undefined}
            onClick={() => setLength(minutes)}
          >
            {minutes < 60 ? `${minutes} min` : `${minutes / 60} h`}
          </button>
        ))}
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.actions}>
        {draft.block && (
          <Button
            variant="danger"
            disabled={busy}
            onClick={() =>
              draft.block &&
              remove.mutate(draft.block.id, {
                onSuccess: onClose,
                onError: (failure) => setError(errorMessage(failure)),
              })
            }
          >
            Delete
          </Button>
        )}
        <span className={styles.spacer} />
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          {draft.block ? "Save" : "Plan"}
        </Button>
      </div>
    </form>
  );
}

/** The draft of an existing block, in local time. */
export function draftOf(block: TimeBlock): BlockDraft {
  return {
    block,
    day: toLocalDate(block.startAt, timeZone),
    start: toLocalTime(block.startAt, timeZone),
    end: toLocalTime(block.endAt, timeZone),
    todo: block.todo ? { id: block.todo.id, title: block.todo.title } : null,
  };
}
