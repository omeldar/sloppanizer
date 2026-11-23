import { type Meeting, toLocalDate } from "@organizer/shared";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button, EmptyState, ErrorState, Loading, PageHeader } from "../../components/ui.tsx";
import { useKeys } from "../../keyboard/KeyboardProvider.tsx";
import { dayLabel, timeZone, localClock } from "../../lib/format.ts";
import { useMeetings } from "../../lib/meetings.ts";
import { MeetingDialog, type MeetingDraft } from "./MeetingDialog.tsx";
import styles from "./Meetings.module.css";

/** Meetings with a next date first (soonest on top), ended ones last by name. */
export function byNext(a: Meeting, b: Meeting): number {
  if (a.next && b.next) return a.next.startAt.localeCompare(b.next.startAt);
  if (a.next || b.next) return a.next ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/** "Thu 20.11., 09:00" for the next date, in local time. */
export const nextText = (startAt: string): string =>
  `${dayLabel(toLocalDate(startAt, timeZone))}, ${localClock(startAt)}`;

export function MeetingsPage() {
  const meetings = useMeetings();
  const [draft, setDraft] = useState<MeetingDraft | null>(null);
  useKeys([{ keys: "a", run: () => setDraft({}), label: "New meeting", group: "Meetings" }]);

  const list = (meetings.data ?? []).toSorted(byNext);
  return (
    <div className={styles.page}>
      <PageHeader
        title="Meetings"
        actions={
          <Button size="sm" variant="primary" hint="a" onClick={() => setDraft({})}>
            New meeting
          </Button>
        }
      />
      {meetings.isPending && <Loading />}
      {meetings.isError && <ErrorState error={meetings.error} onRetry={() => void meetings.refetch()} />}
      {meetings.isSuccess && list.length === 0 && (
        <EmptyState>
          No meetings yet. Add your standup: it shows what you have not said yet, and it repeats in the
          Planner.
        </EmptyState>
      )}
      <ul className={styles.cards}>
        {list.map((meeting) => (
          <li key={meeting.id}>
            <Link to="/meetings/$id" params={{ id: String(meeting.id) }} className={styles.card}>
              <span className={styles.cardHead}>
                <span className={styles.cardName}>{meeting.name}</span>
                <span className={styles.typePill} data-type={meeting.type}>
                  {meeting.type === "standup" ? "Standup" : "Other"}
                </span>
              </span>
              <span className={styles.cardSchedule}>{meeting.schedule.text}</span>
              <span className={styles.cardFoot}>
                <span className={styles.cardNext}>
                  {meeting.next ? `Next ${nextText(meeting.next.startAt)}` : "No next date"}
                </span>
                {meeting.openCount !== null && (
                  <span className={styles.toSay} data-none={meeting.openCount === 0 || undefined}>
                    {meeting.openCount === 0 ? "Nothing to say" : `${meeting.openCount} to say`}
                  </span>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <MeetingDialog draft={draft} onClose={() => setDraft(null)} />
    </div>
  );
}
