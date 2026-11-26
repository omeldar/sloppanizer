import { type MeetingOccurrence, toLocalDate, toLocalTime } from "@organizer/shared";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Dialog } from "../../components/Dialog.tsx";
import { Button, Field } from "../../components/ui.tsx";
import { dayLabel, timeZone } from "../../lib/format.ts";
import styles from "./Planner.module.css";
import { blockSpan, lengthMinutes, spanText } from "./planner.ts";
import { DateInput, TimeInput } from "../../components/DateTimeInputs.tsx";

/**
 * A meeting date in the planner: when it is, its standup list and note, and moving or cancelling it.
 * Both ask which dates they are for (this one, this and following, all) before anything changes.
 */
export function OccurrenceDialog({
  occurrence,
  onClose,
  onMove,
  onCancel,
}: {
  occurrence: MeetingOccurrence | null;
  onClose: () => void;
  onMove: (occurrence: MeetingOccurrence, span: { startAt: string; endAt: string }) => void;
  onCancel: (occurrence: MeetingOccurrence) => void;
}) {
  return (
    <Dialog
      open={occurrence !== null}
      onOpenChange={(open) => !open && onClose()}
      title={occurrence?.name ?? "Meeting"}
      width={440}
    >
      {occurrence && (
        <OccurrenceBody
          key={`${occurrence.meetingId}-${occurrence.occursOn}`}
          occurrence={occurrence}
          onClose={onClose}
          onMove={onMove}
          onCancel={onCancel}
        />
      )}
    </Dialog>
  );
}

function OccurrenceBody({
  occurrence,
  onClose,
  onMove,
  onCancel,
}: {
  occurrence: MeetingOccurrence;
  onClose: () => void;
  onMove: (occurrence: MeetingOccurrence, span: { startAt: string; endAt: string }) => void;
  onCancel: (occurrence: MeetingOccurrence) => void;
}) {
  const [moving, setMoving] = useState(false);
  const [day, setDay] = useState(toLocalDate(occurrence.startAt, timeZone));
  const [start, setStart] = useState(toLocalTime(occurrence.startAt, timeZone));
  const [end, setEnd] = useState(toLocalTime(occurrence.endAt, timeZone));
  const [error, setError] = useState<string | null>(null);
  const meetingLink = {
    to: "/meetings/$id",
    params: { id: String(occurrence.meetingId) },
    search: { on: occurrence.occursOn },
  } as const;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (lengthMinutes(start, end) < 5) {
      setError("A meeting lasts at least 5 minutes.");
      return;
    }
    onMove(occurrence, blockSpan(day, start, end, timeZone));
  };

  return (
    <div className={styles.form}>
      <p className={styles.occurrenceWhen}>
        <span>{dayLabel(toLocalDate(occurrence.startAt, timeZone))}</span>
        <span className={styles.occurrenceTime}>{spanText(occurrence, timeZone)}</span>
        {occurrence.oneTime && <span className={styles.occurrenceMoved}>once</span>}
        {!occurrence.oneTime && occurrence.status === "moved" && (
          <span className={styles.occurrenceMoved}>moved from {dayLabel(occurrence.occursOn)}</span>
        )}
      </p>
      <div className={styles.occurrenceLinks}>
        <Link {...meetingLink} className={styles.occurrenceLink} onClick={onClose}>
          {occurrence.type === "standup" ? "Open the standup list" : "Open the meeting"}
        </Link>
        {occurrence.noteId !== null ? (
          <Link
            to="/notes/$id"
            params={{ id: String(occurrence.noteId) }}
            className={styles.occurrenceLink}
            onClick={onClose}
          >
            Open the note
          </Link>
        ) : (
          <Link {...meetingLink} className={styles.occurrenceLink} onClick={onClose}>
            Write a note
          </Link>
        )}
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
            {occurrence.oneTime ? "Delete" : "Cancel date"}
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
