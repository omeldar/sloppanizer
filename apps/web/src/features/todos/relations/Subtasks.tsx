import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { STATUS_LABELS, type Todo } from "@organizer/shared";
import { Link } from "@tanstack/react-router";
import { type CSSProperties, type Ref, useState } from "react";
import { Menu } from "../../../components/Menu.tsx";
import { type KeyBinding, useKeys } from "../../../keyboard/KeyboardProvider.tsx";
import { dueState } from "../../../lib/format.ts";
import { childrenParams, useTodos } from "../../../lib/queries.ts";
import { planMove } from "../../board/positions.ts";
import { useTodoActions } from "../useTodoActions.ts";
import styles from "./Relations.module.css";
import { SubtaskInput } from "./SubtaskInput.tsx";

/** Where a child lands when it moves one step (alt+j / alt+k); null at the ends. */
export function stepTarget(ids: readonly number[], id: number, delta: 1 | -1): number | null {
  const from = ids.indexOf(id);
  const to = from + delta;
  return from === -1 || to < 0 || to >= ids.length ? null : to;
}

/** Subtasks of a todo: progress, the children in order (drag or alt+j/alt+k), add and move out. */
export function Subtasks({ todo, inputRef }: { todo: Todo; inputRef?: Ref<HTMLInputElement> }) {
  const children = useTodos(childrenParams(todo.id));
  const { toggleDone, patch } = useTodoActions();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const list = children.data?.items ?? [];
  const { total, done } = todo.progress.subtasks;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const moveTo = (id: number, index: number) => {
    for (const change of planMove(list, id, index)) void patch(change.id, { position: change.position });
  };
  const step = (delta: 1 | -1) => {
    if (selectedId === null) return;
    const to = stepTarget(
      list.map((c) => c.id),
      selectedId,
      delta,
    );
    if (to !== null) moveTo(selectedId, to);
  };
  const bindings: KeyBinding[] = [
    { keys: "alt+j", run: () => step(1), label: "Move the subtask down", group: "Subtasks" },
    { keys: "alt+k", run: () => step(-1), label: "Move the subtask up", group: "Subtasks" },
  ];
  useKeys(bindings, { enabled: list.length > 1 });

  const onDragEnd = (event: DragEndEvent) => {
    const id = Number(event.active.id);
    const overIndex = list.findIndex((c) => c.id === Number(event.over?.id));
    if (event.over && overIndex !== -1 && event.over.id !== event.active.id) moveTo(id, overIndex);
  };

  return (
    <section className={styles.section} aria-label="Subtasks">
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Subtasks</h2>
        {total > 0 && (
          <>
            <span
              className={styles.progress}
              role="progressbar"
              aria-label="Subtasks done"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={done}
            >
              <span style={{ width: `${(done / total) * 100}%` }} />
            </span>
            <span className={styles.count}>
              {done} of {total} done
            </span>
          </>
        )}
      </div>
      {list.length > 0 && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={list.map((c) => c.id)} strategy={verticalListSortingStrategy}>
            <ol className={styles.rows} aria-label="Subtasks in order">
              {list.map((child) => (
                <SubtaskRow
                  key={child.id}
                  todo={child}
                  selected={child.id === selectedId}
                  onSelect={() => setSelectedId(child.id)}
                  onToggle={() => void toggleDone(child)}
                  onMoveOut={() => void patch(child.id, { parentId: null })}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}
      <SubtaskInput todoId={todo.id} inputRef={inputRef} />
    </section>
  );
}

function SubtaskRow({
  todo,
  selected,
  onSelect,
  onToggle,
  onMoveOut,
}: {
  todo: Todo;
  selected: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onMoveOut: () => void;
}) {
  const sortable = useSortable({ id: todo.id });
  const done = todo.status === "done";
  const style: CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };
  return (
    <li
      ref={sortable.setNodeRef}
      style={style}
      className={styles.row}
      data-selected={selected || undefined}
      data-dragging={sortable.isDragging || undefined}
      data-done={done || undefined}
      tabIndex={0}
      aria-label={`#${todo.id} ${todo.title}`}
      onFocus={onSelect}
      onMouseDown={onSelect}
    >
      <span
        className={styles.handle}
        {...sortable.attributes}
        {...sortable.listeners}
        tabIndex={-1}
        aria-hidden="true"
      >
        ⋮⋮
      </span>
      <input
        type="checkbox"
        className={styles.check}
        checked={done}
        onChange={onToggle}
        aria-label={done ? `Reopen #${todo.id}` : `Mark #${todo.id} done`}
      />
      <span className={styles.rowId}>#{todo.id}</span>
      <Link to="/todos/$id" params={{ id: String(todo.id) }} className={styles.rowTitle}>
        {todo.title}
      </Link>
      <span className={styles.rowStatus}>{STATUS_LABELS[todo.status]}</span>
      <span className={styles.rowDue} data-state={todo.dueOn && !done ? dueState(todo.dueOn) : undefined}>
        {todo.dueOn ?? ""}
      </span>
      <Menu
        label={`Subtask #${todo.id}`}
        trigger={
          <button type="button" className={styles.rowMenu} aria-label={`More for #${todo.id}`}>
            ...
          </button>
        }
        items={[{ label: "Move out (make it a top-level todo)", run: onMoveOut }]}
      />
    </li>
  );
}
