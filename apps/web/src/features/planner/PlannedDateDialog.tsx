import { type BlockOccurrence, toLocalDate, toLocalTime } from "@organizer/shared";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Dialog } from "../../components/Dialog.tsx";
import { Button, Field } from "../../components/ui.tsx";
import { dayLabel, timeZone } from "../../lib/format.ts";
import { useRepeatPlan } from "../../lib/plans.ts";
import styles from "./Planner.module.css";
import { blockSpan, lengthMinutes, spanText } from "./planner.ts";
import { DateInput, TimeInput } from "../../components/DateTimeInputs.tsx";

/**
 * A planned date of a repeating todo: when it is, which todo it is for, and moving or removing it. Both
 * ask which dates they are for (this one, this and following, all) before anything changes.
 */
export function PlannedDateDialog({
  occurrence,
  onClose,
  onMove,
  onCancel,
}: {
  occurrence: BlockOccurrence | null;
  onClose: () => void;
  onMove: (occurrence: BlockOccurrence, span: { startAt: string; endAt: string }) => void;
  onCancel: (occurrence: BlockOccurrence) => void;
}) {
  return (
    <Dialog
      open={occurrence !== null}
      onOpenChange={(open) => !open && onClose()}
      title={occurrence?.todo.title ?? "Planned time"}
      width={440}
    >
      {occurrence && (
        <PlannedDateBody
          key={`${occurrence.seriesId}-${occurrence.occursOn}`}
          occurrence={occurrence}
          onClose={onClose}
          onMove={onMove}
          onCancel={onCancel}
        />
      )}
    </Dialog>
  );
}

function PlannedDateBody({
  occurrence,
  onClose,
  onMove,
  onCancel,
}: {
  occurrence: BlockOccurrence;
  onClose: () => void;
  onMove: (occurrence: BlockOccurrence, span: { startAt: string; endAt: string }) => void;
  onCancel: (occurrence: BlockOccurrence) => void;
}) {
  const plan = useRepeatPlan(occurrence.ownerTodoId);
  const [moving, setMoving] = useState(false);
  const [day, setDay] = useState(toLocalDate(occurrence.startAt, timeZone));
  const [start, setStart] = useState(toLocalTime(occurrence.startAt, timeZone));
  const [end, setEnd] = useState(toLocalTime(occurrence.endAt, timeZone));
  const [error, setError] = useState<string | null>(null);
  const done = occurrence.todo.status === "done";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (lengthMinutes(start, end) < 5) {
      setError("Planned time lasts at least 5 minutes.");
      return;
    }
    onMove(occurrence, blockSpan(day, start, end, timeZone));
  };

  return (
    <div className={styles.form}>
      <p className={styles.occurrenceWhen}>
        <span>{dayLabel(toLocalDate(occurrence.startAt, timeZone))}</span>
        <span className={styles.occurrenceTime}>{spanText(occurrence, timeZone)}</span>
        {occurrence.status === "moved" && (
          <span className={styles.occurrenceMoved}>moved from {dayLabel(occurrence.occursOn)}</span>
        )}
      </p>
      <p className={styles.repeatText}>
        Repeats with the todo{plan.data ? `: ${plan.data.schedule.text}` : ""}.{" "}
        {done ? "This date's todo is done." : "Marking a date done keeps the next ones planned."}
      </p>
      <div className={styles.occurrenceLinks}>
        <Link
          to="/todos/$id"
          params={{ id: String(occurrence.todo.id) }}
          className={styles.occurrenceLink}
          onClick={onClose}
        >
          Open #{occurrence.todo.id}
        </Link>
        <Link to="/recurring" className={styles.occurrenceLink} onClick={onClose}>
          All repeating todos
        </Link>
      </div>

      {moving ? (
        <form className={styles.moveForm} onSubmit={submit} aria-label="Move to">
          <div className={styles.timeRow}>
            <Field label="Day">
              <DateInput value={day} onChange={(value) => setDay(value)} required />
            </Field>
            <Field label="From">
              <TimeInput step={300} value={start} onChange={(value) => setStart(value)} required />
            </Field>
            <Field label="To">
              <TimeInput step={300} value={end} onChange={(value) => setEnd(value)} required />
            </Field>
          </div>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.actions}>
            <span className={styles.spacer} />
            <Button onClick={() => setMoving(false)}>Back</Button>
            <Button type="submit" variant="primary">
              Move
            </Button>
          </div>
        </form>
      ) : (
        <div className={styles.actions}>
          <Button variant="danger" onClick={() => onCancel(occurrence)}>
            Remove
          </Button>
          <span className={styles.spacer} />
          <Button onClick={() => setMoving(true)}>Move</Button>
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </div>
      )}
    </div>
  );
}
