import { PRIORITIES, type Reason, type Todo } from "@organizer/shared";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { TodoPickerDialog, type PickerKind } from "../../features/todos/TodoPickerDialog.tsx";
import { useTodoActions } from "../../features/todos/useTodoActions.ts";
import { type KeyBinding, useKeys } from "../../keyboard/KeyboardProvider.tsx";
import { StripRow } from "./StripRow.tsx";
import { stepCursor } from "../../lib/listCursor.ts";
import styles from "./Strip.module.css";

export interface StripItem {
  todo: Todo;
  rank?: number;
  reasons?: readonly Reason[];
  score?: number;
}

interface Props {
  items: readonly StripItem[];
  label: string;
  ranked?: boolean;
  /** Fold rows away when marked done (the list does not show done todos). */
  collapseOnDone?: boolean;
  /** Only one list per page owns j/k and the row keys. */
  keys?: boolean;
}

export function StripList({ items, label, ranked = false, collapseOnDone = true, keys = true }: Props) {
  const navigate = useNavigate();
  const { toggleDone, setPriority, patch } = useTodoActions();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [picker, setPicker] = useState<{ todo: Todo; kind: PickerKind } | null>(null);

  const index = items.findIndex((item) => item.todo.id === selectedId);
  const selected = index === -1 ? undefined : items[index]?.todo;

  const move = (delta: number) =>
    setSelectedId(
      stepCursor(
        items.map((item) => item.todo.id),
        selectedId,
        delta,
      ),
    );

  const onSelected = (run: (todo: Todo) => void) => () => {
    if (selected) run(selected);
  };

  const bindings: KeyBinding[] = [
    { keys: "j", run: () => move(1), label: "Next row", group: "List" },
    { keys: "ArrowDown", run: () => move(1) },
    { keys: "k", run: () => move(-1), label: "Previous row", group: "List" },
    { keys: "ArrowUp", run: () => move(-1) },
    {
      keys: "Enter",
      run: onSelected((todo) => void navigate({ to: "/todos/$id", params: { id: String(todo.id) } })),
      label: "Open todo",
      group: "List",
    },
    {
      keys: "x",
      run: onSelected((todo) => void toggleDone(todo)),
      label: "Mark done or reopen",
      group: "List",
    },
    { keys: "e", run: onSelected((todo) => setEditingId(todo.id)), label: "Edit title", group: "List" },
    {
      keys: "l",
      run: onSelected((todo) => setPicker({ todo, kind: "labels" })),
      label: "Labels",
      group: "List",
    },
    {
      keys: "p",
      run: onSelected((todo) => setPicker({ todo, kind: "project" })),
      label: "Project",
      group: "List",
    },
    {
      keys: "r",
      run: onSelected((todo) => setPicker({ todo, kind: "people" })),
      label: "Requested by",
      group: "List",
    },
    {
      keys: "o",
      run: onSelected((todo) => setPicker({ todo, kind: "contacts" })),
      label: "Contacts",
      group: "List",
    },
    ...PRIORITIES.map((priority, i) => ({
      keys: String(i + 1),
      run: onSelected((todo) => void setPriority(todo, priority)),
      label: i === 0 ? "Priority critical, high, medium, low (1 to 4)" : undefined,
      group: "List",
    })),
  ];
  useKeys(bindings, { enabled: keys && editingId === null });

  return (
    <>
      <ol className={styles.bay} data-ranked={ranked || undefined} aria-label={label}>
        <li className={styles.header} aria-hidden="true">
          <span />
          {ranked && <span />}
          <span />
          <span />
          <span />
          <span />
          <span>Due</span>
          <span>Age</span>
          <span>Project</span>
        </li>
        {items.map((item) => (
          <StripRow
            key={item.todo.id}
            todo={item.todo}
            rank={item.rank}
            reasons={item.reasons}
            score={item.score}
            selected={item.todo.id === selectedId}
            collapseOnDone={collapseOnDone}
            editingTitle={item.todo.id === editingId}
            onSelect={() => setSelectedId(item.todo.id)}
            onToggleDone={(todo) => void toggleDone(todo)}
            onTitleSave={(title) => {
              setEditingId(null);
              void patch(item.todo.id, { title });
            }}
            onTitleCancel={() => setEditingId(null)}
          />
        ))}
      </ol>
      {picker && <TodoPickerDialog todo={picker.todo} kind={picker.kind} onClose={() => setPicker(null)} />}
    </>
  );
}
