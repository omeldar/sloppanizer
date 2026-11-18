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
import { type CSSProperties, type Ref, useRef, useState } from "react";
import { Menu } from "../../../components/Menu.tsx";
import { useToast } from "../../../components/toast/ToastProvider.tsx";
import { type KeyBinding, useKeys } from "../../../keyboard/KeyboardProvider.tsx";
import { errorMessage } from "../../../lib/api.ts";
import { dueState, formatDate } from "../../../lib/format.ts";
import { childrenParams, useSavePositions, useTodos } from "../../../lib/queries.ts";
import { planMove } from "../../../lib/positions.ts";
import { useTodoActions } from "../useTodoActions.ts";
import styles from "./Relations.module.css";
import { SuggestSteps } from "./SuggestSteps.tsx";
import { SubtaskInput } from "./SubtaskInput.tsx";

/** Where a child lands when it moves one step (alt+j / alt+k); null at the ends. */
export function stepTarget(ids: readonly number[], id: number, delta: 1 | -1): number | null {
  const from = ids.indexOf(id);
  const to = from + delta;
  return from === -1 || to < 0 || to >= ids.length ? null : to;
}

/** The children with positions that are not saved yet, in the server's order (position, then id). */
export function withPositions(items: readonly Todo[], unsaved: ReadonlyMap<number, number>): Todo[] {
  if (unsaved.size === 0) return [...items];
  return items
    .map((item) => {
      const position = unsaved.get(item.id);
      return position === undefined ? item : { ...item, position };
    })
    .toSorted((a, b) => a.position - b.position || a.id - b.id);
}

/** Subtasks of a todo: progress, the children in order (drag or alt+j/alt+k), add and move out. */
export function Subtasks({ todo, inputRef }: { todo: Todo; inputRef?: Ref<HTMLInputElement> }) {
  const children = useTodos(childrenParams(todo.id));
  const { toggleDone, patch } = useTodoActions();
  const savePositions = useSavePositions();
  const toast = useToast();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // New positions show at once and stay until the server's list has them.
  const [unsaved, setUnsaved] = useState<ReadonlyMap<number, number>>(new Map());
  const list = withPositions(children.data?.items ?? [], unsaved);
  const { total, done } = todo.progress.subtasks;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  // One move is saved after the other, so quick alt+j presses reach the server in order.
  const saving = useRef<Promise<void>>(Promise.resolve());

  const moveTo = (id: number, index: number) => {
    const plan = planMove(list, id, index).filter(
      (change) => list.find((c) => c.id === change.id)?.position !== change.position,
    );
    if (plan.length === 0) return;
    setUnsaved((current) => new Map([...current, ...plan.map((c) => [c.id, c.position] as const)]));
    const save = async () => {
      try {
        await savePositions.mutateAsync(plan);
      } catch (error) {
        toast.show({ tone: "error", message: `Could not save the order. ${errorMessage(error)}` });
      } finally {
        setUnsaved((current) => {
          const next = new Map(current);
          // A later move of the same row keeps its own value.
          for (const change of plan) if (next.get(change.id) === change.position) next.delete(change.id);
          return next;
        });
      }
    };
    saving.current = saving.current.then(save);
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
      <SuggestSteps todo={todo} existing={list.map((c) => c.title)} />
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
  // The row is not a focus stop itself: focus on its checkbox, link or menu selects it for alt+j/alt+k.
  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- selects the row, see above
    <li
      ref={sortable.setNodeRef}
      style={style}
      className={styles.row}
      data-selected={selected || undefined}
      // oxlint-disable-next-line react/refs -- isDragging is state from dnd-kit, not a ref
      data-dragging={sortable.isDragging || undefined}
      data-done={done || undefined}
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
        {todo.dueOn ? formatDate(todo.dueOn) : ""}
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
