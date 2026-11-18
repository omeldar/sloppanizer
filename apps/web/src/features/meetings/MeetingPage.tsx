import { addDays, type Meeting, type MeetingOccurrence } from "@organizer/shared";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Dialog, DialogActions, DialogBody } from "../../components/Dialog.tsx";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import { Button, EmptyState, ErrorState, Loading, PageHeader } from "../../components/ui.tsx";
import { useKeys } from "../../keyboard/KeyboardProvider.tsx";
import { ApiError, errorMessage } from "../../lib/api.ts";
import { dayLabel, formatDate, today } from "../../lib/format.ts";
import {
  defaultMeetingDate,
  stepMeetingDate,
  useChangeOccurrence,
  useDeleteMeeting,
  useMeeting,
  useOccurrences,
} from "../../lib/meetings.ts";
import { MeetingDialog, type MeetingDraft } from "./MeetingDialog.tsx";
import { nextText } from "./MeetingsPage.tsx";
import styles from "./Meetings.module.css";

const route = getRouteApi("/meetings/$id");

/** One meeting, phone first: a date switcher, then what to say (standups), the note and the repeat. */
export function MeetingPage() {
  const { id } = route.useParams();
  const meetingId = Number(id);
  const meeting = useMeeting(meetingId);
  if (!Number.isInteger(meetingId) || (meeting.error instanceof ApiError && meeting.error.status === 404)) {
    return (
      <EmptyState>
        There is no meeting {id}. It may have been deleted. <Link to="/meetings">Back to the meetings</Link>.
      </EmptyState>
    );
  }
  if (meeting.isPending) return <Loading />;
  if (meeting.isError) return <ErrorState error={meeting.error} onRetry={() => void meeting.refetch()} />;
  return <MeetingView meeting={meeting.data} />;
}

function MeetingView({ meeting }: { meeting: Meeting }) {
  const search = route.useSearch();
  const navigate = useNavigate();
  const on = search.on ?? defaultMeetingDate(meeting.segments, today()) ?? meeting.schedule.startsOn;
  const [draft, setDraft] = useState<MeetingDraft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The dates around the shown one, cancelled ones too, to say what happened to this one.
  const occurrences = useOccurrences({
    from: addDays(on, -31),
    to: addDays(on, 31),
    meetingId: meeting.id,
    cancelled: "true",
  });
  const occurrence = occurrences.data?.find((o) => o.occursOn === on && o.meetingId === meeting.id);
  const previous = stepMeetingDate(meeting.segments, on, -1);
  const next = stepMeetingDate(meeting.segments, on, 1);

  const show = (date: string | null) =>
    date &&
    void navigate({
      to: "/meetings/$id",
      params: { id: String(meeting.id) },
      search: { ...search, on: date },
    });
  useKeys([
    { keys: "[", run: () => show(previous), label: "Previous date", group: "Meeting" },
    { keys: "]", run: () => show(next), label: "Next date", group: "Meeting" },
    { keys: "e", run: () => setDraft({ meeting, from: on }), label: "Edit meeting", group: "Meeting" },
  ]);

  return (
    <div className={styles.page}>
      <PageHeader
        title={meeting.name}
        meta={
          <span className={styles.typePill} data-type={meeting.type}>
            {meeting.type === "standup" ? "Standup" : "Other"}
          </span>
        }
        actions={
          <Button size="sm" hint="e" onClick={() => setDraft({ meeting, from: on })}>
            Edit
          </Button>
        }
      />
      <nav className={styles.dates} aria-label="Meeting dates">
        <button
          type="button"
          className={styles.dateStep}
          onClick={() => show(previous)}
          disabled={previous === null}
          aria-label="Previous date"
        >
          ‹
        </button>
        <span className={styles.dateNow} aria-live="polite">
          <span className={styles.dateLabel}>{dayLabel(on)}</span>
          <OccurrenceState meetingId={meeting.id} on={on} occurrence={occurrence} />
        </span>
        <button
          type="button"
          className={styles.dateStep}
          onClick={() => show(next)}
          disabled={next === null}
          aria-label="Next date"
        >
          ›
        </button>
      </nav>

      <section className={styles.schedule} aria-label="Repeat">
        <h2 className={styles.sectionTitle}>Repeat</h2>
        <ul className={styles.segments}>
          {meeting.segments.map((segment) => (
            <li key={segment.id}>
              {meeting.segments.length > 1 && (
                <span className={styles.segmentFrom}>From {formatDate(segment.startsOn)}: </span>
              )}
              {segment.text}
            </li>
          ))}
        </ul>
        <p className={styles.quiet}>
          {meeting.next ? `Next ${nextText(meeting.next.startAt)}.` : "No next date."} Move or cancel single
          dates in the <Link to="/planner">Planner</Link>.
        </p>
        <div className={styles.scheduleActions}>
          <Button size="sm" onClick={() => setDraft({ meeting, from: on })}>
            Edit meeting
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
            Delete meeting
          </Button>
        </div>
      </section>

      <MeetingDialog draft={draft} onClose={() => setDraft(null)} />
      <DeleteMeetingDialog meeting={meeting} open={confirmDelete} onOpenChange={setConfirmDelete} />
    </div>
  );
}

/** What happened to the shown date: cancelled or moved (with an undo), or nothing. */
function OccurrenceState({
  meetingId,
  on,
  occurrence,
}: {
  meetingId: number;
  on: string;
  occurrence: MeetingOccurrence | undefined;
}) {
  const change = useChangeOccurrence();
  const toast = useToast();
  if (!occurrence || occurrence.status === "scheduled") return null;
  const restore = () =>
    change.mutate(
      { id: meetingId, on, change: { scope: "this", cancelled: false } },
      { onError: (failure) => toast.show({ tone: "error", message: errorMessage(failure) }) },
    );
  return (
    <span className={styles.dateState} data-status={occurrence.status}>
      {occurrence.status === "cancelled" ? "Cancelled" : `Moved to ${nextText(occurrence.startAt)}`}
      <button type="button" className={styles.linkButton} onClick={restore} disabled={change.isPending}>
        {occurrence.status === "cancelled" ? "Restore" : "Undo move"}
      </button>
    </span>
  );
}

function DeleteMeetingDialog({
  meeting,
  open,
  onOpenChange,
}: {
  meeting: Meeting;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const remove = useDeleteMeeting();
  const navigate = useNavigate();
  const toast = useToast();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete "${meeting.name}"?`}
      description="Every date goes, with what you marked as said. The notes of its dates stay in Notes."
      width={440}
    >
      <DialogBody>
        <DialogActions>
          <Button onClick={() => onOpenChange(false)}>Keep it</Button>
          <Button
            variant="danger"
            disabled={remove.isPending}
            onClick={async () => {
              try {
                await remove.mutateAsync(meeting.id);
                onOpenChange(false);
                toast.show({ message: `Deleted "${meeting.name}"` });
                void navigate({ to: "/meetings" });
              } catch (error) {
                toast.show({
                  tone: "error",
                  message: `Could not delete the meeting. ${errorMessage(error)}`,
                });
              }
            }}
          >
            Delete meeting
          </Button>
        </DialogActions>
      </DialogBody>
    </Dialog>
  );
}
