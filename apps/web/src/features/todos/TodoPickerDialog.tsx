import type { PersonRef, PersonRole, Todo, UpdateTodo } from "@organizer/shared";
import { Dialog } from "../../components/Dialog.tsx";
import { LabelPicker, PeoplePicker, type PersonChoice } from "../../components/pickers/pickers.tsx";
import { useTodo } from "../../lib/queries.ts";
import { TodoProjectPicker } from "./TodoProjectPicker.tsx";
import { useTodoActions } from "./useTodoActions.ts";

export type PickerKind = "labels" | "project" | "people" | "contacts";

const TITLES: Record<PickerKind, string> = {
  labels: "Labels",
  project: "Project",
  people: "Requested by",
  contacts: "Contacts",
};

export function personRef(choice: PersonChoice): PersonRef {
  if ("personId" in choice) return { personId: choice.personId };
  if ("username" in choice) return { username: choice.username };
  return { firstName: choice.firstName, lastName: choice.lastName };
}

/** Adds the person in that role, or removes them when they already have it. */
export function togglePersonPatch(
  todo: Pick<Todo, "requestedBy" | "contacts">,
  role: PersonRole,
  choice: PersonChoice,
): UpdateTodo {
  const current = role === "contact" ? todo.contacts : todo.requestedBy;
  const linked = "personId" in choice && current.some((p) => p.id === choice.personId);
  const ref = [personRef(choice)];
  if (role === "contact") return linked ? { removeContacts: ref } : { addContacts: ref };
  return linked ? { removeRequestedBy: ref } : { addRequestedBy: ref };
}

/** Picker values: the people already linked in a role. */
export function chosen(people: readonly { id: number; displayName: string }[]): PersonChoice[] {
  return people.map((p) => ({ personId: p.id, displayName: p.displayName }));
}

/** The pickers behind the keys l, p, r and o: each pick is saved right away. */
export function TodoPickerDialog({
  todo: initial,
  kind,
  onClose,
}: {
  todo: Todo;
  kind: PickerKind | null;
  onClose: () => void;
}) {
  const fresh = useTodo(initial.id);
  const todo = fresh.data ?? initial;
  const { patch } = useTodoActions();

  return (
    <Dialog
      open={kind !== null}
      onOpenChange={(open) => !open && onClose()}
      title={`${kind ? TITLES[kind] : ""} for #${todo.id}`}
      width={440}
      placement="top"
    >
      {kind === "labels" && (
        <LabelPicker
          value={todo.labels.map((l) => l.name)}
          onToggle={(name) => {
            const has = todo.labels.some((l) => l.name.toLowerCase() === name.toLowerCase());
            void patch(todo.id, has ? { removeLabels: [name] } : { addLabels: [name] });
          }}
        />
      )}
      {kind === "project" && (
        <TodoProjectPicker
          todo={todo}
          onPick={(projectId) => {
            onClose();
            if (projectId !== todo.projectId) void patch(todo.id, { projectId });
          }}
        />
      )}
      {(kind === "people" || kind === "contacts") && (
        <PeoplePicker
          label={TITLES[kind]}
          value={chosen(kind === "contacts" ? todo.contacts : todo.requestedBy)}
          onToggle={(choice) =>
            void patch(
              todo.id,
              togglePersonPatch(todo, kind === "contacts" ? "contact" : "requester", choice),
            )
          }
        />
      )}
    </Dialog>
  );
}
