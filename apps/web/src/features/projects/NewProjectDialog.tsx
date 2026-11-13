import { PROJECT_COLORS } from "@organizer/shared";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Dialog, DialogBody, DialogActions } from "../../components/Dialog.tsx";
import { Button, Field, TextInput } from "../../components/ui.tsx";
import { errorMessage } from "../../lib/api.ts";
import { useCreateProject } from "../../lib/queries.ts";
import styles from "./Projects.module.css";

export function NewProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New project" width={420}>
      {open && <NewProjectForm onDone={() => onOpenChange(false)} />}
    </Dialog>
  );
}

function NewProjectForm({ onDone }: { onDone: () => void }) {
  const create = useCreateProject();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(PROJECT_COLORS[1]);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const project = await create.mutateAsync({ name: name.trim(), color });
      onDone();
      void navigate({ to: "/projects/$slug", params: { slug: project.slug } });
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
          placeholder="Home lab"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog opens to type a name
          autoFocus
          required
          maxLength={100}
        />
      </Field>
      <ColorChoice value={color} onChange={setColor} />
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <DialogActions>
        <Button type="submit" variant="primary" disabled={!name.trim() || create.isPending}>
          Create project
        </Button>
      </DialogActions>
    </DialogBody>
  );
}

export function ColorChoice({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return (
    <fieldset className={styles.colors}>
      <legend className={styles.legend}>Color</legend>
      {PROJECT_COLORS.map((color) => (
        <label
          key={color}
          className={styles.color}
          style={{ background: color }}
          data-on={color.toLowerCase() === value.toLowerCase() || undefined}
        >
          <input
            type="radio"
            name="color"
            value={color}
            checked={color.toLowerCase() === value.toLowerCase()}
            onChange={() => onChange(color)}
            className="visually-hidden"
          />
          <span className="visually-hidden">{color}</span>
        </label>
      ))}
    </fieldset>
  );
}
