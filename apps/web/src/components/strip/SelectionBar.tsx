import {
  type BulkPatch,
  PRIORITIES,
  PRIORITY_SCOPE,
  type Priority,
  parseLabelName,
  scopeKey,
  type Todo,
  type TodoStatus,
} from "@organizer/shared";
import { useState } from "react";
import { DateInput } from "../DateTimeInputs.tsx";
import { Dialog, DialogActions, DialogBody } from "../Dialog.tsx";
import { Menu, type MenuItem } from "../Menu.tsx";
import {
  LabelPicker,
  PeoplePicker,
  type PersonChoice,
  ProjectPicker,
  toggleLabel,
} from "../pickers/pickers.tsx";
import { Button, Field } from "../ui.tsx";
import { personRef } from "../../features/todos/TodoPickerDialog.tsx";
import { todoCount, useBulkActions } from "../../features/todos/useBulkActions.ts";
import { currentSpace } from "../../lib/api.ts";
import { formatDate } from "../../lib/format.ts";
import { useProjects } from "../../lib/queries.ts";
import { useCurrentSpace } from "../../lib/spaces.ts";
import styles from "./SelectionBar.module.css";

const STATUSES: { status: TodoStatus; label: string }[] = [
  { status: "open", label: "Open" },
  { status: "in_progress", label: "In progress" },
  { status: "blocked", label: "Blocked" },
  { status: "done", label: "Done" },
];

const STATUS_TEXT: Record<TodoStatus, string> = {
  open: "open",
  in_progress: "in progress",
  blocked: "blocked",
  done: "done",
};

type DialogKind = "project" | "addLabels" | "removeLabels" | "requestedBy" | "contacts" | "planned" | "due";

const TITLES: Record<DialogKind, string> = {
  project: "Move to project",
  addLabels: "Add labels",
  removeLabels: "Remove labels",
  requestedBy: "Set requested by",
  contacts: "Add contacts",
  planned: "Planned day",
  due: "Due date",
};

const names = (choices: readonly PersonChoice[]) => choices.map((c) => c.displayName).join(", ");
const listed = (items: readonly string[]) => items.join(", ");

/** The names of the priority labels on these todos (to remove the priority). */
function priorityLabels(todos: readonly Todo[]): string[] {
  const found = new Map<string, string>();
  for (const todo of todos) {
    for (const label of todo.labels) {
      const { scope } = parseLabelName(label.name);
      if (scope !== null && scopeKey(scope) === PRIORITY_SCOPE)
        found.set(label.name.toLowerCase(), label.name);
    }
  }
  return [...found.values()];
}

/**
 * The bar over a list while todos are checked (S5#14): how many, select all, clear (Esc), and the
 * changes for all of them at once. Each change is one bulk call with an undo toast.
 */
export function SelectionBar({
  todos,
  total,
  onSelectAll,
  onClear,
}: {
  /** The checked todos, in list order. */
  todos: readonly Todo[];
  /** How many todos the list shows. */
  total: number;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  const { apply } = useBulkActions();
  const projects = useProjects();
  const inSpace = currentSpace() !== null;
  const space = useCurrentSpace();
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [confirm, setConfirm] = useState<PersonChoice[] | null>(null);
  const count = todos.length;
  const them = todoCount(count);

  const run = (patch: BulkPatch, message: string) => {
    setDialog(null);
    void apply(todos, patch, message);
  };

  const projectName = (id: number | null) =>
    id === null ? "the Inbox" : (projects.data?.find((p) => p.id === id)?.name ?? `project ${id}`);
  const shared = new Set(todos.map((t) => t.projectId));
  const projectValue = shared.size === 1 ? todos[0]?.projectId : undefined;

  const statusItems: MenuItem[] = STATUSES.map(({ status, label }) => ({
    label,
    run: () =>
      run({ status }, status === "done" ? `Marked ${them} done` : `Set ${them} to ${STATUS_TEXT[status]}`),
  }));
  const setPriority = (priority: Priority) =>
    run({ addLabels: [`${PRIORITY_SCOPE}::${priority}`] }, `Set priority ${priority} on ${them}`);
  const priorityItems: MenuItem[] = [
    ...PRIORITIES.map((priority) => ({
      label: priority[0]?.toUpperCase() + priority.slice(1),
      run: () => setPriority(priority),
    })),
    {
      label: "No priority",
      run: () => {
        const remove = priorityLabels(todos);
        if (remove.length > 0) run({ removeLabels: remove }, `Removed the priority from ${them}`);
      },
    },
  ];
  const members = space.data?.members ?? [];
  const assigneeItems: MenuItem[] = [
    { label: "Nobody", run: () => run({ assignee: null }, `Unassigned ${them}`) },
    ...members.map((m) => ({
      label: m.name === m.username ? m.username : `${m.name} (${m.username})`,
      run: () => run({ assignee: m.username }, `Assigned ${them} to ${m.username}`),
    })),
  ];
  const withRequesters = todos.filter((t) => t.requestedBy.length > 0);
  const requestedByMessage = (choices: readonly PersonChoice[]) =>
    choices.length === 0
      ? `Cleared requested by on ${them}`
      : `Set requested by to ${names(choices)} on ${them}`;

  return (
    <div className={styles.bar} role="toolbar" aria-label="Selected todos">
      <span className={styles.count} aria-live="polite">
        {count} selected
      </span>
      {count < total && (
        <Button variant="ghost" size="sm" onClick={onSelectAll}>
          Select all {total}
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={onClear} hint="Escape">
        Clear
      </Button>
      <span className={styles.divider} aria-hidden="true" />
      <Button variant="primary" size="sm" onClick={() => run({ status: "done" }, `Marked ${them} done`)}>
        Done
      </Button>
      <Menu
        label="Status"
        items={statusItems}
        trigger={
          <Button size="sm" aria-haspopup="menu">
            Status
          </Button>
        }
      />
      <Menu
        label="Priority"
        items={priorityItems}
        trigger={
          <Button size="sm" aria-haspopup="menu">
            Priority
          </Button>
        }
      />
      <Button size="sm" onClick={() => setDialog("project")}>
        Move
      </Button>
      <Button size="sm" onClick={() => setDialog("addLabels")}>
        Add labels
      </Button>
      <Button size="sm" onClick={() => setDialog("removeLabels")}>
        Remove labels
      </Button>
      <Button size="sm" onClick={() => setDialog("requestedBy")}>
        Requested by
      </Button>
      <Button size="sm" onClick={() => setDialog("contacts")}>
        Add contacts
      </Button>
      <Button size="sm" onClick={() => setDialog("planned")}>
        Planned
      </Button>
      <Button size="sm" onClick={() => setDialog("due")}>
        Due
      </Button>
      {inSpace && (
        <Menu
          label="Assign to"
          items={assigneeItems}
          trigger={
            <Button size="sm" aria-haspopup="menu">
              Assign
            </Button>
          }
        />
      )}

      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => !open && setDialog(null)}
        title={dialog ? `${TITLES[dialog]}: ${them}` : ""}
        width={440}
        placement="top"
      >
        {dialog === "project" && (
          <ProjectPicker
            value={projectValue}
            onChange={(projectId) => run({ projectId }, `Moved ${them} to ${projectName(projectId)}`)}
          />
        )}
        {(dialog === "addLabels" || dialog === "removeLabels") && (
          <LabelStep
            mode={dialog === "addLabels" ? "add" : "remove"}
            count={count}
            onDone={(labels) =>
              run(
                dialog === "addLabels" ? { addLabels: labels } : { removeLabels: labels },
                dialog === "addLabels"
                  ? `Added ${listed(labels)} to ${them}`
                  : `Removed ${listed(labels)} from ${them}`,
              )
            }
          />
        )}
        {(dialog === "requestedBy" || dialog === "contacts") && (
          <PeopleStep
            mode={dialog}
            count={count}
            onDone={(choices) => {
              if (dialog === "contacts") {
                run(
                  { addContacts: choices.map(personRef) },
                  `Added ${names(choices)} as ${choices.length === 1 ? "contact" : "contacts"} to ${them}`,
                );
                return;
              }
              // Nothing to overwrite: no need to ask.
              if (withRequesters.length === 0) {
                run({ requestedBy: choices.map(personRef) }, requestedByMessage(choices));
                return;
              }
              setDialog(null);
              setConfirm(choices);
            }}
          />
        )}
        {(dialog === "planned" || dialog === "due") && (
          <DateStep
            mode={dialog}
            onDone={(date) => {
              if (dialog === "planned") {
                run(
                  { plannedOn: date },
                  date ? `Planned ${them} for ${formatDate(date)}` : `Unplanned ${them}`,
                );
              } else {
                run(
                  { dueOn: date },
                  date ? `Set due ${formatDate(date)} on ${them}` : `Cleared the due date of ${them}`,
                );
              }
            }}
          />
        )}
      </Dialog>

      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`Replace requested by on ${them}?`}
        width={480}
      >
        {confirm && (
          <DialogBody>
            <p className={styles.warning}>This overwrites requested by on {withRequesters.length} of them:</p>
            <ul className={styles.overwrites}>
              {withRequesters.slice(0, 8).map((todo) => (
                <li key={todo.id}>
                  <span className={styles.ref}>{inSpace ? "" : `#${todo.id} `}</span>
                  {todo.title}: {todo.requestedBy.map((p) => p.displayName).join(", ")}
                </li>
              ))}
              {withRequesters.length > 8 && <li>and {withRequesters.length - 8} more</li>}
            </ul>
            <p className={styles.warning}>
              {confirm.length === 0
                ? "Afterwards none of the todos has anyone as requested by."
                : `Afterwards every todo has only ${names(confirm)} as requested by.`}
            </p>
            <DialogActions>
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  const choices = confirm;
                  setConfirm(null);
                  void apply(todos, { requestedBy: choices.map(personRef) }, requestedByMessage(choices));
                }}
              >
                Replace on {them}
              </Button>
            </DialogActions>
          </DialogBody>
        )}
      </Dialog>
    </div>
  );
}

/** Pick the labels first, then add or remove them on every todo with one button. */
function LabelStep({
  mode,
  count,
  onDone,
}: {
  mode: "add" | "remove";
  count: number;
  onDone: (labels: string[]) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <>
      <LabelPicker
        value={picked}
        onToggle={(name) =>
          setPicked((current) =>
            mode === "add"
              ? toggleLabel(current, name)
              : current.some((n) => n.toLowerCase() === name.toLowerCase())
                ? current.filter((n) => n.toLowerCase() !== name.toLowerCase())
                : [...current, name],
          )
        }
      />
      <div className={styles.step}>
        <Button variant="primary" disabled={picked.length === 0} onClick={() => onDone(picked)}>
          {mode === "add" ? "Add to" : "Remove from"} {todoCount(count)}
        </Button>
      </div>
    </>
  );
}

const choiceKey = (c: PersonChoice) =>
  "personId" in c ? `p${c.personId}` : "username" in c ? `u${c.username}` : `n${c.displayName.toLowerCase()}`;

/** Pick people first; requested by then asks before it replaces anything. */
function PeopleStep({
  mode,
  count,
  onDone,
}: {
  mode: "requestedBy" | "contacts";
  count: number;
  onDone: (choices: PersonChoice[]) => void;
}) {
  const [picked, setPicked] = useState<PersonChoice[]>([]);
  return (
    <>
      <PeoplePicker
        label={mode === "contacts" ? "Contacts" : "Requested by"}
        value={picked}
        onToggle={(choice) =>
          setPicked((current) =>
            current.some((c) => choiceKey(c) === choiceKey(choice))
              ? current.filter((c) => choiceKey(c) !== choiceKey(choice))
              : [...current, choice],
          )
        }
      />
      <div className={styles.step}>
        {mode === "requestedBy" ? (
          <Button variant="primary" onClick={() => onDone(picked)}>
            {picked.length === 0 ? `Clear on ${todoCount(count)}` : `Replace on ${todoCount(count)}`}
          </Button>
        ) : (
          <Button variant="primary" disabled={picked.length === 0} onClick={() => onDone(picked)}>
            Add to {todoCount(count)}
          </Button>
        )}
      </div>
    </>
  );
}

function DateStep({ mode, onDone }: { mode: "planned" | "due"; onDone: (date: string | null) => void }) {
  const [date, setDate] = useState("");
  return (
    <DialogBody
      onSubmit={(event) => {
        event.preventDefault();
        if (date) onDone(date);
      }}
    >
      <Field label={mode === "planned" ? "Planned for" : "Due on"}>
        <DateInput
          value={date}
          onChange={setDate}
          aria-label={mode === "planned" ? "Planned for" : "Due on"}
        />
      </Field>
      <DialogActions>
        <Button variant="ghost" onClick={() => onDone(null)}>
          {mode === "planned" ? "Unplan all" : "Clear due dates"}
        </Button>
        <Button type="submit" variant="primary" disabled={!date}>
          Set
        </Button>
      </DialogActions>
    </DialogBody>
  );
}
