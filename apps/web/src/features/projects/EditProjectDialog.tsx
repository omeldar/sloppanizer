import type { Project, UpdateProject } from "@organizer/shared";
import { type FormEvent, useState } from "react";
import { Dialog, DialogActions, DialogBody } from "../../components/Dialog.tsx";
import { Button, Field, TextInput } from "../../components/ui.tsx";
import { errorMessage } from "../../lib/api.ts";
import { useUpdateProject } from "../../lib/queries.ts";
import { ColorChoice } from "./NewProjectDialog.tsx";
import styles from "./Projects.module.css";

/** Name, description and color of a project; the slug (and with it the URL) stays. */
export function EditProjectDialog({
  project,
  onOpenChange,
}: {
  project: Project | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={project !== null} onOpenChange={onOpenChange} title="Edit project" width={420}>
      {project && <EditProjectForm key={project.id} project={project} onDone={() => onOpenChange(false)} />}
    </Dialog>
  );
}

/** Only the fields that changed, so an untouched form sends nothing. */
export function projectPatch(
  project: Pick<Project, "name" | "description" | "color">,
  next: { name: string; description: string; color: string },
): UpdateProject {
  const name = next.name.trim();
  return {
    ...(name !== project.name && { name }),
    ...(next.description !== project.description && { description: next.description }),
    ...(next.color.toLowerCase() !== project.color.toLowerCase() && { color: next.color }),
  };
}

function EditProjectForm({ project, onDone }: { project: Project; onDone: () => void }) {
  const update = useUpdateProject();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [color, setColor] = useState(project.color);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const patch = projectPatch(project, { name, description, color });
    try {
      if (Object.keys(patch).length > 0) await update.mutateAsync({ id: project.id, patch });
      onDone();
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  return (
    <DialogBody onSubmit={submit}>
      <Field label="Name">
        <TextInput
          value={name}
          onChange={(e) => setName(e.target.value)}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog opens to change the name or color
          autoFocus
          required
          maxLength={100}
        />
      </Field>
      <Field label="Description">
        <textarea
          className={styles.description}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What the project is about (optional)"
          rows={3}
          maxLength={2000}
        />
      </Field>
      <ColorChoice value={color} onChange={setColor} />
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <DialogActions>
        <Button type="submit" variant="primary" disabled={!name.trim() || update.isPending}>
          Save
        </Button>
      </DialogActions>
    </DialogBody>
  );
}
