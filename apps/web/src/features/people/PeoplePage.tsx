import { DuplicatePersonDetails, type Person, type Todo } from "@organizer/shared";
import { type FormEvent, useState } from "react";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  PageHeader,
  TextInput,
} from "../../components/ui.tsx";
import { ApiError, errorMessage } from "../../lib/api.ts";
import { useCreatePerson, useDeletePerson, usePeople, useTodos } from "../../lib/queries.ts";
import styles from "./People.module.css";

export interface PersonCounts {
  requested: number;
  open: number;
  done: number;
}

/** Requested, open and done counts per person id. */
export function countByPerson(
  todos: readonly Pick<Todo, "status" | "requestedBy">[],
): Map<number, PersonCounts> {
  const counts = new Map<number, PersonCounts>();
  for (const todo of todos) {
    for (const person of todo.requestedBy) {
      const entry = counts.get(person.id) ?? { requested: 0, open: 0, done: 0 };
      entry.requested += 1;
      if (todo.status === "done") entry.done += 1;
      else entry.open += 1;
      counts.set(person.id, entry);
    }
  }
  return counts;
}

export function PeoplePage() {
  const people = usePeople();
  // The contract has no per person counts yet, so they are counted from the todo list (max 500).
  const todos = useTodos({ status: "all", limit: 500 });
  const counts = countByPerson(todos.data?.items ?? []);

  return (
    <div className={styles.page}>
      <PageHeader
        title="People"
        meta={
          people.data ? `${people.data.length} ${people.data.length === 1 ? "person" : "people"}` : undefined
        }
      />
      <AddPerson />
      {people.isPending && <Loading />}
      {people.isError && <ErrorState error={people.error} onRetry={() => void people.refetch()} />}
      {people.data?.length === 0 && (
        <EmptyState>
          No people yet. Add someone above, or type a name in the Requested by field of a todo.
        </EmptyState>
      )}
      {people.data && people.data.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Note</th>
              <th scope="col" className={styles.num}>
                Requested
              </th>
              <th scope="col" className={styles.num}>
                Open
              </th>
              <th scope="col" className={styles.num}>
                Done
              </th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {people.data.map((person) => (
              <PersonRow key={person.id} person={person} counts={counts.get(person.id)} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function PersonRow({ person, counts }: { person: Person; counts?: PersonCounts }) {
  const remove = useDeletePerson();
  const toast = useToast();
  return (
    <tr>
      <td className={styles.name}>{person.displayName}</td>
      <td className={styles.note}>{person.note}</td>
      <td className={styles.num}>{counts?.requested ?? 0}</td>
      <td className={styles.num}>{counts?.open ?? 0}</td>
      <td className={styles.num}>{counts?.done ?? 0}</td>
      <td className={styles.actions}>
        <Button
          size="sm"
          variant="ghost"
          disabled={remove.isPending}
          onClick={async () => {
            try {
              await remove.mutateAsync(person.id);
              toast.show({ message: `Removed ${person.displayName}` });
            } catch (error) {
              toast.show({ tone: "error", message: errorMessage(error) });
            }
          }}
        >
          Remove
        </Button>
      </td>
    </tr>
  );
}

function AddPerson() {
  const create = useCreatePerson();
  const toast = useToast();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [note, setNote] = useState("");
  const [duplicate, setDuplicate] = useState<Person | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (allowDuplicate: boolean) => {
    setError(null);
    try {
      const person = await create.mutateAsync({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        note: note.trim(),
        allowDuplicate,
      });
      toast.show({ message: `Added ${person.displayName}` });
      setFirstName("");
      setLastName("");
      setNote("");
      setDuplicate(null);
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
    <form className={styles.add} onSubmit={submit}>
      <Field label="First name">
        <TextInput
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          required
          maxLength={100}
        />
      </Field>
      <Field label="Last name">
        <TextInput value={lastName} onChange={(e) => setLastName(e.target.value)} required maxLength={100} />
      </Field>
      <Field label="Note (tells namesakes apart)">
        <TextInput
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={2000}
          placeholder="Team, place or role"
        />
      </Field>
      <Button type="submit" disabled={!firstName.trim() || !lastName.trim() || create.isPending}>
        Add person
      </Button>
      {duplicate && (
        <div className={styles.duplicate} role="alert">
          <span>
            {duplicate.displayName} already exists{duplicate.note ? ` (${duplicate.note})` : ""}. Add a note
            to tell them apart, then add anyway.
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
    </form>
  );
}
