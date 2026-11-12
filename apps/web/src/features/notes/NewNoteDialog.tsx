import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { useCommands } from "../../app/commands.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { Popover } from "../../components/Popover.tsx";
import { ProjectPicker } from "../../components/pickers/pickers.tsx";
import { Button, Field, FieldButton, TextInput } from "../../components/ui.tsx";
import { errorMessage } from "../../lib/api.ts";
import { useCreateNote, useProjects } from "../../lib/queries.ts";
import styles from "./Notes.module.css";

/** Key n: a title (and project) first, then the note opens to write the body. */
export function NewNoteDialog() {
  const { newNote, close } = useCommands();
  return (
    <Dialog
      open={newNote !== null}
      onOpenChange={(open) => !open && close("newNote")}
      title="New note"
      width={480}
      placement="top"
    >
      {newNote && <NewNoteForm projectId={newNote.projectId} onDone={() => close("newNote")} />}
    </Dialog>
  );
}

function NewNoteForm({ projectId: startProject, onDone }: { projectId: number | null; onDone: () => void }) {
  const create = useCreateNote();
  const projects = useProjects();
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState<number | null>(startProject);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const project = projects.data?.find((p) => p.id === projectId);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return setError("Give the note a title.");
    try {
      const note = await create.mutateAsync({ title: title.trim(), projectId });
      onDone();
      void navigate({ to: "/notes/$id", params: { id: String(note.id) }, search: { write: true } });
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  return (
    <form className={styles.newForm} onSubmit={submit}>
      <Field label="Title">
        <TextInput
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Meeting notes, how-to, ideas"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog opens to type a title
          autoFocus
          maxLength={200}
        />
      </Field>
      <div className={styles.newRow}>
        <span className={styles.newLabel}>Project</span>
        <Popover
          open={picking}
          onOpenChange={setPicking}
          trigger={<FieldButton empty={!project}>{project?.name ?? "No project"}</FieldButton>}
        >
          <ProjectPicker
            value={projectId}
            noneLabel="No project"
            onChange={(id) => {
              setProjectId(id);
              setPicking(false);
            }}
          />
        </Popover>
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.newActions}>
        <Button type="submit" variant="primary" disabled={create.isPending}>
          Create note
        </Button>
      </div>
    </form>
  );
}
