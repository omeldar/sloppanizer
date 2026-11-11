import type { PersonRef, Todo } from "@organizer/shared";
import { Dialog } from "../../components/Dialog.tsx";
import {
  LabelPicker,
  PeoplePicker,
  type PersonChoice,
  ProjectPicker,
} from "../../components/pickers/pickers.tsx";
import { useTodo } from "../../lib/queries.ts";
import { useTodoActions } from "./useTodoActions.ts";

export type PickerKind = "labels" | "project" | "people";

const TITLES: Record<PickerKind, string> = { labels: "Labels", project: "Project", people: "Requested by" };

export function personRef(choice: PersonChoice): PersonRef {
  return "personId" in choice
    ? { personId: choice.personId }
    : { firstName: choice.firstName, lastName: choice.lastName };
}

/** The pickers behind the keys l, p and r: each pick is saved right away. */
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
        <ProjectPicker
          value={todo.projectId}
          onChange={(projectId) => {
            onClose();
            if (projectId !== todo.projectId) void patch(todo.id, { projectId });
          }}
        />
      )}
      {kind === "people" && (
        <PeoplePicker
          value={todo.requestedBy.map((p) => ({ personId: p.id, displayName: p.displayName }))}
          onToggle={(choice) => {
            const linked = "personId" in choice && todo.requestedBy.some((p) => p.id === choice.personId);
            void patch(
              todo.id,
              linked ? { removeRequestedBy: [personRef(choice)] } : { addRequestedBy: [personRef(choice)] },
            );
          }}
        />
      )}
    </Dialog>
  );
}
