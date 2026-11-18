import type { MeetingNote as MeetingNoteLink, Note } from "@organizer/shared";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { MarkdownField } from "../../components/markdown/MarkdownField.tsx";
import { Picker } from "../../components/pickers/Picker.tsx";
import { Popover } from "../../components/Popover.tsx";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import { Button, ErrorState, Loading } from "../../components/ui.tsx";
import { errorMessage } from "../../lib/api.ts";
import { dayLabel, formatDate } from "../../lib/format.ts";
import { useAddMeetingNote, useMeetingNotes, useUnlinkMeetingNote } from "../../lib/meetings.ts";
import { useNote, useNotes, useUpdateNote } from "../../lib/queries.ts";
import { SelectionTodoMenu } from "../notes/SelectionTodoMenu.tsx";
import styles from "./Meetings.module.css";

/**
 * The note of one meeting date, written right here (it is a normal note, in Notes too), or buttons to
 * add a new one or link an existing one. Under it, the other dates that have a note.
 */
export function MeetingNote({ meetingId, on }: { meetingId: number; on: string }) {
  const links = useMeetingNotes(meetingId);
  const [fresh, setFresh] = useState<number | null>(null);
  if (links.isPending) return <Loading label="Loading the notes" />;
  if (links.isError) return <ErrorState error={links.error} onRetry={() => void links.refetch()} />;
  const link = links.data.find((l) => l.on === on);
  const others = links.data.filter((l) => l.on !== on);
  return (
    <section className={styles.noteSection} aria-label="Note">
      <h2 className={styles.sectionTitle}>Note for {dayLabel(on)}</h2>
      {link ? (
        <LinkedNote link={link} write={fresh === link.note.id} />
      ) : (
        <NoNote meetingId={meetingId} on={on} onCreated={setFresh} />
      )}
      {others.length > 0 && <OtherNotes meetingId={meetingId} links={others} />}
    </section>
  );
}

function LinkedNote({ link, write }: { link: MeetingNoteLink; write: boolean }) {
  const note = useNote(link.note.id);
  const unlink = useUnlinkMeetingNote();
  const toast = useToast();
  return (
    <div className={styles.note}>
      <div className={styles.noteBar}>
        <Link to="/notes/$id" params={{ id: String(link.note.id) }} className={styles.noteTitle}>
          {link.note.title}
        </Link>
        <Button
          size="sm"
          variant="ghost"
          disabled={unlink.isPending}
          onClick={() =>
            unlink.mutate(
              { id: link.meetingId, on: link.on },
              {
                onSuccess: () =>
                  toast.show({ message: `"${link.note.title}" is no longer this date's note` }),
                onError: (failure) => toast.show({ tone: "error", message: errorMessage(failure) }),
              },
            )
          }
        >
          Unlink
        </Button>
      </div>
      {note.isPending && <Loading label="Loading the note" />}
      {note.isError && <ErrorState error={note.error} onRetry={() => void note.refetch()} />}
      {note.isSuccess && <NoteText note={note.data} write={write} />}
    </div>
  );
}

function NoteText({ note, write }: { note: Note; write: boolean }) {
  const update = useUpdateNote();
  const toast = useToast();
  return (
    <SelectionTodoMenu>
      <MarkdownField
        title="Text"
        value={note.bodyMd}
        startWriting={write}
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- a new note opens ready to type
        autoFocus={write}
        save={async (bodyMd) => {
          try {
            await update.mutateAsync({ id: note.id, patch: { bodyMd } });
            return true;
          } catch (error) {
            toast.show({ tone: "error", message: `Could not save the note. ${errorMessage(error)}` });
            return false;
          }
        }}
        emptyText="Nothing written yet. Choose Write to start."
      />
    </SelectionTodoMenu>
  );
}

function NoNote({
  meetingId,
  on,
  onCreated,
}: {
  meetingId: number;
  on: string;
  onCreated: (noteId: number) => void;
}) {
  const add = useAddMeetingNote();
  const toast = useToast();
  const [picking, setPicking] = useState(false);
  const [search, setSearch] = useState("");
  const notes = useNotes({ q: search.trim(), limit: 20 });
  const failed = (failure: unknown) => toast.show({ tone: "error", message: errorMessage(failure) });
  return (
    <div className={styles.noteActions}>
      <Button
        variant="primary"
        disabled={add.isPending}
        onClick={() =>
          add.mutate({ id: meetingId, on }, { onSuccess: (link) => onCreated(link.note.id), onError: failed })
        }
      >
        Add note
      </Button>
      <Popover
        open={picking}
        onOpenChange={setPicking}
        trigger={<Button disabled={add.isPending}>Link a note</Button>}
      >
        <Picker
          label="Notes"
          placeholder="Search notes"
          search={search}
          onSearchChange={setSearch}
          items={(notes.data?.items ?? []).map((n) => ({ value: String(n.id), label: n.title }))}
          selected={new Set()}
          onPick={(id) => {
            setPicking(false);
            add.mutate({ id: meetingId, on, noteId: Number(id) }, { onError: failed });
          }}
          empty="No note matches."
        />
      </Popover>
    </div>
  );
}

/** Other dates with a note, newest first; a tap shows that date. */
function OtherNotes({ meetingId, links }: { meetingId: number; links: MeetingNoteLink[] }) {
  const navigate = useNavigate();
  return (
    <div className={styles.otherNotes}>
      <h3 className={styles.otherTitle}>Notes of other dates</h3>
      <ul className={styles.otherList}>
        {links.map((link) => (
          <li key={link.on}>
            <button
              type="button"
              className={styles.otherNote}
              onClick={() =>
                void navigate({
                  to: "/meetings/$id",
                  params: { id: String(meetingId) },
                  search: { on: link.on },
                })
              }
            >
              <span className={styles.otherDate}>{formatDate(link.on)}</span>
              <span className={styles.otherNoteTitle}>{link.note.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
