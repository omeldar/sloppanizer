import { DuplicatePersonDetails, type Person } from "@organizer/shared";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import { useCommands } from "../../app/commands.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { Button, Field, TextInput } from "../../components/ui.tsx";
import { ApiError, errorMessage } from "../../lib/api.ts";
import { useCreatePerson, useTeams } from "../../lib/queries.ts";
import styles from "./People.module.css";

export function NewPersonDialog() {
  const { newPerson, close } = useCommands();
  return (
    <Dialog
      open={newPerson}
      onOpenChange={(open) => !open && close("newPerson")}
      title="New person"
      width={520}
      placement="top"
    >
      {newPerson && <NewPersonForm onDone={() => close("newPerson")} />}
    </Dialog>
  );
}

function NewPersonForm({ onDone }: { onDone: () => void }) {
  const create = useCreatePerson();
  const navigate = useNavigate();
  const teams = useTeams();
  const teamList = useId();
  const [form, setForm] = useState({ firstName: "", lastName: "", note: "", team: "", email: "" });
  const [duplicate, setDuplicate] = useState<Person | null>(null);
  const [error, setError] = useState<string | null>(null);
  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  const save = async (allowDuplicate: boolean) => {
    setError(null);
    try {
      const person = await create.mutateAsync({
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        note: form.note.trim(),
        team: form.team.trim(),
        email: form.email.trim(),
        allowDuplicate,
      });
      onDone();
      void navigate({ to: "/people/$id", params: { id: String(person.id) } });
    } catch (failure) {
      const existing =
        failure instanceof ApiError && failure.code === "conflict"
          ? DuplicatePersonDetails.safeParse(failure.details)
          : null;
      if (existing?.success) setDuplicate(existing.data.existing);
      else setError(errorMessage(failure));
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save(false);
  };

  return (
    <form className={styles.newForm} onSubmit={submit}>
      <div className={styles.newRow}>
        <Field label="First name">
          {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog opens to type a name */}
          <TextInput {...field("firstName")} required maxLength={100} autoFocus />
        </Field>
        <Field label="Last name">
          <TextInput {...field("lastName")} required maxLength={100} />
        </Field>
      </div>
      <Field label="Short note" hint="Shown next to the name in pickers, tells namesakes apart.">
        <TextInput {...field("note")} maxLength={2000} placeholder="Platform team, Basel" />
      </Field>
      <div className={styles.newRow}>
        <Field label="Team">
          <TextInput {...field("team")} maxLength={100} list={teamList} placeholder="Team or department" />
        </Field>
        <Field label="Email">
          <TextInput {...field("email")} type="email" maxLength={254} placeholder="name@example.com" />
        </Field>
      </div>
      <datalist id={teamList}>
        {(teams.data ?? []).map((team) => (
          // oxlint-disable-next-line jsx-a11y/control-has-associated-label -- a datalist suggestion; its value is the text
          <option key={team.name} value={team.name} />
        ))}
      </datalist>
      {duplicate && (
        <div className={styles.duplicate} role="alert">
          <span>
            {duplicate.displayName} already exists{duplicate.note ? ` (${duplicate.note})` : ""}. Add a short
            note to tell them apart, then add anyway.
          </span>
          <Button size="sm" onClick={() => void save(true)}>
            Add anyway
          </Button>
        </div>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.newActions}>
        <Button
          type="submit"
          variant="primary"
          disabled={!form.firstName.trim() || !form.lastName.trim() || create.isPending}
        >
          Add person
        </Button>
      </div>
    </form>
  );
}
