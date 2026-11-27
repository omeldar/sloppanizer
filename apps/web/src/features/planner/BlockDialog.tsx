import {
  canRepeatPlan,
  describeRecurrence,
  type TimeBlock,
  toLocalDate,
  toLocalTime,
} from "@organizer/shared";
import { Link } from "@tanstack/react-router";
import { type CSSProperties, type FormEvent, useState } from "react";
import { useCurrentAccount } from "../../app/account.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import { Button, Field, TextInput } from "../../components/ui.tsx";
import { currentSpace, errorMessage } from "../../lib/api.ts";
import { sharedTodoHref } from "../../lib/spaces.ts";
import { timeZone } from "../../lib/format.ts";
import { useCreateRepeatPlan, useRepeatPlan } from "../../lib/plans.ts";
import { useCreateBlock, useDeleteBlock, useTodo, useUpdateBlock } from "../../lib/queries.ts";
import type { PersonChoice } from "../../components/pickers/pickers.tsx";
import { useCreateMeeting } from "../../lib/meetings.ts";
import { MeetingPeopleField } from "../meetings/MeetingPeopleField.tsx";
import meetingStyles from "../meetings/Meetings.module.css";
import { personRef } from "../todos/TodoPickerDialog.tsx";
import { type PickedTodo, TodoSearchPicker } from "../todos/relations/TodoSearchPicker.tsx";
import styles from "./Planner.module.css";
import { blockSpan, lengthMinutes, minutesToTime, timeToMinutes } from "./planner.ts";
import { DateInput, TimeInput } from "../../components/DateTimeInputs.tsx";

export interface BlockDraft {
  /** An existing block to edit, or none for a new one. */
  block?: TimeBlock;
  day: string;
  start: string;
  end: string;
  /** With `space`, a todo of that shared project: the time is planned there. */
  todo?: PickedTodo | null;
}

/**
 * What planning a shared project's todo did to its assignee, for the toast: planning gives a todo nobody
 * is on to whoever planned it; someone else's stays theirs.
 */
export function plannedSharedText(
  title: string,
  assignee: Pick<TimeBlock, "assignee">["assignee"],
  me: string | null,
): string {
  if (assignee === null) return `Planned ${title}`;
  if (assignee.username === me) return `Planned ${title}, assigned to you`;
  return `Planned ${title}; it stays assigned to ${assignee.name}`;
}

/**
 * Creates or edits one time block: for a todo (search) or with a title, a day, start and end. New time
 * for a todo that repeats on a schedule repeats with it by default (every date of its repeat). New time
 * can also be a one-time meeting instead (Meeting): a name and the people in it, counted as meeting time.
 */
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
  const createRepeat = useCreateRepeatPlan();
  const toast = useToast();
  const account = useCurrentAccount();
  const [todo, setTodo] = useState<PickedTodo | null>(draft.todo ?? null);
  // A block of a shared project (in your own tab) stays there; its todo is changed in that project's tab.
  const blockSpace = draft.block?.space ?? null;
  const space = blockSpace ?? todo?.space ?? null;
  // Only new time for an own todo can repeat; the picker knows id and title, so its repeat is looked up.
  const full = useTodo(draft.block || todo?.space ? 0 : (todo?.id ?? 0));
  const rule = full.data?.id === todo?.id ? (full.data?.recurrence ?? null) : null;
  const repeatable = canRepeatPlan(rule);
  const existing = useRepeatPlan(todo?.id ?? 0, repeatable);
  const hasPlan = existing.data != null;
  const [repeatChoice, setRepeatChoice] = useState<boolean | null>(null);
  const repeat = repeatable && !hasPlan && (repeatChoice ?? true);
  const [title, setTitle] = useState(draft.block?.title ?? "");
  const [day, setDay] = useState(draft.day);
  const [start, setStart] = useState(draft.start);
  // A time field cannot show 24:00: midnight at the end is 00:00, which blockSpan reads as the next day.
  const [end, setEnd] = useState(draft.end === "24:00" ? "00:00" : draft.end);
  const [error, setError] = useState<string | null>(null);
  // Only a new block can become a meeting; one dragged in for a todo stays work.
  const canBeMeeting = !draft.block && !draft.todo;
  const [kind, setKind] = useState<"work" | "meeting">("work");
  const meeting = canBeMeeting && kind === "meeting";
  const [people, setPeople] = useState<PersonChoice[]>([]);
  const createMeeting = useCreateMeeting();
  const busy =
    create.isPending ||
    update.isPending ||
    remove.isPending ||
    createRepeat.isPending ||
    createMeeting.isPending;

  // Late blocks may run past midnight into the next day.
  const setLength = (minutes: number) => setEnd(minutesToTime((timeToMinutes(start) + minutes) % (24 * 60)));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (meeting) {
      if (title.trim() === "") return setError("Give the meeting a name.");
      const minutes = lengthMinutes(start, end);
      if (minutes < 5) return setError("A meeting lasts at least 5 minutes.");
      createMeeting.mutate(
        {
          name: title.trim(),
          // No rule: the meeting happens once, on this day.
          schedule: { startsOn: day, startTime: start, durationMinutes: minutes },
          ...(people.length > 0 && { people: people.map(personRef) }),
        },
        { onSuccess: onClose, onError: (failure: unknown) => setError(errorMessage(failure)) },
      );
      return;
    }
    if (!todo && title.trim() === "") {
      setError("Pick a todo or give the block a title.");
      return;
    }
    const span = blockSpan(day, start, end, timeZone);
    const body = { todoId: todo?.id ?? null, title: todo ? "" : title.trim(), ...span };
    const done = { onSuccess: onClose, onError: (failure: unknown) => setError(errorMessage(failure)) };
    if (repeat && todo) createRepeat.mutate({ todoId: todo.id, span }, done);
    else if (draft.block) update.mutate({ id: draft.block.id, patch: body, space: blockSpace?.id }, done);
    else
      create.mutate(
        { ...body, space: space?.id },
        {
          ...done,
          onSuccess: (block) => {
            onClose();
            if (space && todo)
              toast.show({
                message: plannedSharedText(todo.title, block.assignee, account?.username ?? null),
              });
          },
        },
      );
  };

  return (
    <form className={styles.form} onSubmit={submit}>
      {canBeMeeting && (
        <div className={meetingStyles.typeRow} role="radiogroup" aria-label="What to plan">
          {(["work", "meeting"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={kind === value}
              className={meetingStyles.typeChoice}
              onClick={() => {
                setKind(value);
                setError(null);
              }}
            >
              {value === "work" ? "Work" : "Meeting"}
            </button>
          ))}
          <span className={meetingStyles.typeHint}>
            {meeting
              ? "A meeting on this day only; it counts as time in meetings, also per person."
              : "Time for a todo, or with a title."}
          </span>
        </div>
      )}
      {meeting ? (
        <>
          <Field label="Meeting">
            <TextInput
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Kick-off with Acme, 1:1 with Bo"
              maxLength={200}
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- switching to Meeting is to type its name
              autoFocus
              required
            />
          </Field>
          <MeetingPeopleField value={people} onChange={setPeople} />
        </>
      ) : todo ? (
        <div className={styles.picked}>
          <span className={styles.pickedLabel}>For</span>
          {space ? (
            // Another tab (the shared project's own), so a full page load.
            <a
              href={account ? sharedTodoHref(account.username, space.id, todo.id) : undefined}
              className={styles.pickedTitle}
            >
              {todo.title}
              <span className={styles.fromSpace} style={{ "--swatch": space.color } as CSSProperties}>
                {space.name}
              </span>
            </a>
          ) : (
            <Link
              to="/todos/$id"
              params={{ id: String(todo.id) }}
              className={styles.pickedTitle}
              onClick={onClose}
            >
              #{todo.id} {todo.title}
            </Link>
          )}
          {!blockSpace && (
            <Button size="sm" variant="ghost" onClick={() => setTodo(null)}>
              Change
            </Button>
          )}
        </div>
      ) : (
        <>
          <TodoSearchPicker
            label="Todo"
            // New time in your own tab can be for a todo of a shared project too; an existing block stays
            // where it was planned.
            shared={!draft.block && currentSpace() === null}
            onPick={(picked) => setTodo(picked)}
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
          <DateInput value={day} onChange={(value) => setDay(value)} required />
        </Field>
        <Field label="From">
          <TimeInput step={900} value={start} onChange={(value) => setStart(value)} required />
        </Field>
        <Field label="To">
          <TimeInput step={900} value={end} onChange={(value) => setEnd(value)} required />
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
      {!meeting && repeatable && rule && (
        <div className={styles.repeatChoice}>
          {hasPlan ? (
            <p className={styles.repeatText}>
              Its planned time repeats already ({existing.data?.schedule.text}). This block is for this day
              only.
            </p>
          ) : (
            <label className={styles.repeatLabel}>
              <input
                type="checkbox"
                checked={repeat}
                onChange={(event) => setRepeatChoice(event.target.checked)}
              />
              <span>
                Repeat with the todo ({describeRecurrence(rule)}): the time comes back on every date, also
                after one is done.
              </span>
            </label>
          )}
        </div>
      )}
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
              remove.mutate(
                { id: draft.block.id, space: blockSpace?.id },
                {
                  onSuccess: onClose,
                  onError: (failure) => setError(errorMessage(failure)),
                },
              )
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
          {draft.block ? "Save" : meeting ? "Plan meeting" : "Plan"}
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
    todo: block.todo ? { id: block.todo.id, title: block.todo.title, space: block.space } : null,
  };
}
