import type { Note, UpdateNote } from "@organizer/shared";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Dialog } from "../../components/Dialog.tsx";
import { MarkdownField } from "../../components/markdown/MarkdownField.tsx";
import { Popover } from "../../components/Popover.tsx";
import { ProjectPicker } from "../../components/pickers/pickers.tsx";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import { Button, EmptyState, ErrorState, FieldButton, Loading, TitleInput } from "../../components/ui.tsx";
import { useKeys } from "../../keyboard/KeyboardProvider.tsx";
import { ApiError, errorMessage } from "../../lib/api.ts";
import { absoluteTime, relativeTime } from "../../lib/format.ts";
import { useDeleteNote, useNote, useUpdateNote } from "../../lib/queries.ts";
import styles from "./Notes.module.css";

export function NoteEditor({ id, write }: { id: number; write: boolean }) {
  const note = useNote(id);
  if (note.error instanceof ApiError && note.error.status === 404) {
    return (
      <EmptyState>
        There is no note {id}. It may have been deleted. <Link to="/notes">Back to the notes</Link>.
      </EmptyState>
    );
  }
  if (note.isPending) return <Loading />;
  if (note.isError) return <ErrorState error={note.error} onRetry={() => void note.refetch()} />;
  return <NoteBody note={note.data} write={write} />;
}

function NoteBody({ note, write }: { note: Note; write: boolean }) {
  const update = useUpdateNote();
  const toast = useToast();
  const [editingTitle, setEditingTitle] = useState(false);
  const [picking, setPicking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async (patch: UpdateNote): Promise<boolean> => {
    try {
      await update.mutateAsync({ id: note.id, patch });
      return true;
    } catch (error) {
      toast.show({ tone: "error", message: `Could not save the note. ${errorMessage(error)}` });
      return false;
    }
  };

  useKeys(
    [
      { keys: "e", run: () => setEditingTitle(true), label: "Edit title", group: "Note" },
      { keys: "p", run: () => setPicking(true), label: "Project", group: "Note" },
    ],
    { enabled: !editingTitle },
  );

  return (
    <article className={styles.note}>
      <header className={styles.noteHead}>
        {editingTitle ? (
          <TitleInput
            className={styles.titleInput}
            maxLength={200}
            initial={note.title}
            onDone={(title) => {
              setEditingTitle(false);
              if (title && title !== note.title) void save({ title });
            }}
          />
        ) : (
          <h1 className={styles.noteTitle}>
            <button
              type="button"
              className={styles.titleButton}
              onClick={() => setEditingTitle(true)}
              title="Edit title (e)"
            >
              {note.title}
            </button>
          </h1>
        )}
        <div className={styles.noteBar}>
          <Popover
            open={picking}
            onOpenChange={setPicking}
            trigger={<FieldButton empty={!note.project}>{note.project?.name ?? "No project"}</FieldButton>}
          >
            <ProjectPicker
              value={note.projectId}
              noneLabel="No project"
              onChange={(projectId) => {
                setPicking(false);
                if (projectId !== note.projectId) void save({ projectId });
              }}
            />
          </Popover>
          <Button
            size="sm"
            variant={note.pinnedAt ? "secondary" : "ghost"}
            aria-pressed={note.pinnedAt !== null}
            onClick={() => void save({ pinned: note.pinnedAt === null })}
          >
            {note.pinnedAt ? "Pinned" : "Pin"}
          </Button>
          <span className={styles.noteMeta}>
            updated <time title={absoluteTime(note.updatedAt)}>{relativeTime(note.updatedAt)}</time>, by{" "}
            {note.createdBy}
          </span>
          <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        </div>
      </header>
      <MarkdownField
        title="Text"
        value={note.bodyMd}
        startWriting={write}
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- a new note opens ready to type
        autoFocus={write}
        save={(bodyMd) => save({ bodyMd })}
        emptyText="Nothing written yet. Choose Write to start."
      />
      <DeleteNoteDialog note={note} open={confirmDelete} onOpenChange={setConfirmDelete} />
    </article>
  );
}

function DeleteNoteDialog({
  note,
  open,
  onOpenChange,
}: {
  note: Note;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const remove = useDeleteNote();
  const navigate = useNavigate();
  const toast = useToast();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete "${note.title}"?`}
      description="The note is removed for good. Attached files stay stored."
      width={440}
    >
      <div className={styles.dialogActions}>
        <Button onClick={() => onOpenChange(false)}>Keep it</Button>
        <Button
          variant="danger"
          disabled={remove.isPending}
          onClick={async () => {
            try {
              await remove.mutateAsync(note.id);
              onOpenChange(false);
              toast.show({ message: `Deleted "${note.title}"` });
              void navigate({ to: "/notes" });
            } catch (error) {
              toast.show({ tone: "error", message: `Could not delete the note. ${errorMessage(error)}` });
            }
          }}
        >
          Delete note
        </Button>
      </div>
    </Dialog>
  );
}
