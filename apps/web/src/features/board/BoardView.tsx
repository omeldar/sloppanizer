import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  addDays,
  formatDuration,
  type Todo,
  type TodoStatus,
  type UpdateTodo,
  STATUS_LABELS,
} from "@organizer/shared";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { MiniStrip } from "../../components/strip/MiniStrip.tsx";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import { Button, ErrorState, Loading } from "../../components/ui.tsx";
import { type KeyBinding, useKeys } from "../../keyboard/KeyboardProvider.tsx";
import { today } from "../../lib/format.ts";
import { type TodoListParams, useTodos } from "../../lib/queries.ts";
import { useTodoActions } from "../todos/useTodoActions.ts";
import styles from "./Board.module.css";
import { planMove } from "../../lib/positions.ts";

export const BOARD_COLUMNS: readonly TodoStatus[] = ["open", "in_progress", "blocked", "done"];
const DONE_DAYS = 14;

export interface BoardFilters {
  projectId?: number | "inbox";
  label?: string;
  personId?: number;
}

type Override = Pick<Todo, "status" | "position">;

/** Groups todos by status; open, in progress and blocked by position, done newest first. */
export function boardColumns(
  todos: readonly Todo[],
  overrides: ReadonlyMap<number, Override> = new Map(),
): Record<TodoStatus, Todo[]> {
  const columns: Record<TodoStatus, Todo[]> = { open: [], in_progress: [], blocked: [], done: [] };
  const seen = new Set<number>();
  const moved: Todo[] = [];
  for (const todo of todos) {
    if (seen.has(todo.id)) continue;
    seen.add(todo.id);
    const override = overrides.get(todo.id);
    const shown = override ? { ...todo, ...override } : todo;
    // A todo just dropped on Done goes to the top there, like the server will list it.
    if (override && shown.status === "done" && todo.status !== "done") moved.push(shown);
    else columns[shown.status].push(shown);
  }
  for (const status of ["open", "in_progress", "blocked"] as const) {
    columns[status].sort((a, b) => a.position - b.position || a.id - b.id);
  }
  columns.done = [...moved, ...columns.done];
  return columns;
}

export function BoardView({ filters }: { filters: BoardFilters }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { patch, toggleDone } = useTodoActions();
  const [doneDays, setDoneDays] = useState(DONE_DAYS);
  const doneAfter = addDays(today(), -doneDays);

  const base: TodoListParams = {
    projectId: filters.projectId,
    label: filters.label ? [filters.label] : undefined,
    personId: filters.personId,
    personRole: filters.personId === undefined ? undefined : "any",
    limit: 500,
  };
  const active = useTodos({ ...base, status: "open,in_progress,blocked", sort: "position", order: "asc" });
  const done = useTodos({ ...base, status: "done", doneAfter, sort: "updated", order: "desc" });

  const [overrides, setOverrides] = useState<Map<number, Override>>(new Map());
  const columns = boardColumns([...(active.data?.items ?? []), ...(done.data?.items ?? [])], overrides);

  const [cursor, setCursor] = useState<{ col: number; id: number | null }>({ col: 0, id: null });
  const [dragging, setDragging] = useState<Todo | null>(null);
  const lastDrag = useRef(0);

  const locate = (id: number | null) => {
    if (id === null) return null;
    for (const [col, status] of BOARD_COLUMNS.entries()) {
      const row = columns[status].findIndex((t) => t.id === id);
      if (row !== -1) return { col, row, todo: columns[status][row] as Todo };
    }
    return null;
  };
  const selected = locate(cursor.id);

  /** Moves a todo to a column (and a slot in it), saves it, and offers undo. */
  const move = async (todo: Todo, status: TodoStatus, index?: number) => {
    const before: Override = { status: todo.status, position: todo.position };
    const plan = status !== "done" && index !== undefined ? planMove(columns[status], todo.id, index) : [];
    const own = plan.find((p) => p.id === todo.id);
    const neighbours = plan.filter((p) => p.id !== todo.id && p.position !== findPosition(p.id));
    const change: UpdateTodo = {
      ...(status !== todo.status && { status }),
      ...(own && own.position !== todo.position && { position: own.position }),
    };
    if (Object.keys(change).length === 0) return;

    const ids = [todo.id, ...neighbours.map((p) => p.id)];
    setOverrides((current) => {
      const next = new Map(current);
      next.set(todo.id, { status, position: own?.position ?? todo.position });
      for (const p of neighbours) next.set(p.id, { status, position: p.position });
      return next;
    });
    setCursor({ col: BOARD_COLUMNS.indexOf(status), id: todo.id });

    await Promise.all(neighbours.map((p) => patch(p.id, { position: p.position })));
    const saved = await patch(todo.id, change);
    setOverrides((current) => {
      const next = new Map(current);
      for (const id of ids) next.delete(id);
      return next;
    });
    if (!saved) return;
    toast.show({
      message: change.status ? `Moved #${todo.id} to ${STATUS_LABELS[status]}` : `Moved #${todo.id}`,
      action: {
        label: "Undo",
        run: () => void patch(todo.id, before),
      },
    });
  };

  const findPosition = (id: number) => locate(id)?.todo.position;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const onDragStart = (event: DragStartEvent) => {
    const found = locate(Number(event.active.id));
    setDragging(found?.todo ?? null);
    if (found) setCursor({ col: found.col, id: found.todo.id });
  };

  const onDragEnd = ({ active: dragged, over }: DragEndEvent) => {
    setDragging(null);
    lastDrag.current = Date.now();
    const from = locate(Number(dragged.id));
    if (!from || !over) return;
    const target = over.data.current as { status?: TodoStatus } | undefined;
    const status = target?.status;
    if (!status) return;
    // Order inside Done is by finish time, so a drop there only changes the status.
    if (status === "done") return void move(from.todo, "done");
    const overIndex = columns[status].findIndex((t) => String(t.id) === String(over.id));
    const index = overIndex === -1 ? columns[status].filter((t) => t.id !== from.todo.id).length : overIndex;
    void move(from.todo, status, index);
  };

  const step = (dc: number, dr: number) => {
    const col = Math.max(0, Math.min(BOARD_COLUMNS.length - 1, (selected?.col ?? cursor.col) + dc));
    const list = columns[BOARD_COLUMNS[col] as TodoStatus];
    const row = selected ? (dc === 0 ? selected.row + dr : selected.row) : dr < 0 ? list.length - 1 : 0;
    const clamped = Math.max(0, Math.min(list.length - 1, row));
    setCursor({ col, id: list[clamped]?.id ?? null });
  };

  const shiftSelected = (dc: number) => {
    if (!selected) return;
    const status = BOARD_COLUMNS[selected.col + dc];
    if (status) void move(selected.todo, status);
  };

  const bindings: KeyBinding[] = [
    { keys: "h", run: () => step(-1, 0), label: "Column to the left", group: "Board" },
    { keys: "l", run: () => step(1, 0), label: "Column to the right", group: "Board" },
    { keys: "j", run: () => step(0, 1), label: "Next todo in the column", group: "Board" },
    { keys: "k", run: () => step(0, -1), label: "Previous todo in the column", group: "Board" },
    { keys: "ArrowDown", run: () => step(0, 1) },
    { keys: "ArrowUp", run: () => step(0, -1) },
    { keys: "ArrowLeft", run: () => step(-1, 0) },
    { keys: "ArrowRight", run: () => step(1, 0) },
    { keys: "shift+h", run: () => shiftSelected(-1), label: "Move todo one column left", group: "Board" },
    { keys: "shift+l", run: () => shiftSelected(1), label: "Move todo one column right", group: "Board" },
    {
      keys: "Enter",
      run: () => selected && void navigate({ to: "/todos/$id", params: { id: String(selected.todo.id) } }),
      label: "Open todo",
      group: "Board",
    },
    {
      keys: "x",
      run: () => selected && void toggleDone(selected.todo),
      label: "Mark done or reopen",
      group: "Board",
    },
  ];
  useKeys(bindings);

  if (active.isPending) return <Loading />;
  if (active.isError) return <ErrorState error={active.error} onRetry={() => void active.refetch()} />;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      <div
        className={styles.board}
        // A drop ends with a click on whatever is under the pointer; it must not open the todo.
        onClickCapture={(event) => {
          if (Date.now() - lastDrag.current < 250) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        {BOARD_COLUMNS.map((status, col) => (
          <Column
            key={status}
            status={status}
            todos={columns[status]}
            count={status === "done" ? columns.done.length : columns[status].length}
            cursorHere={cursor.col === col && cursor.id === null}
            onSelect={(id) => setCursor({ col, id })}
            selectedId={cursor.id}
            footer={
              status === "done" && (
                <div className={styles.doneFoot}>
                  <span className={styles.since}>since {doneAfter}</span>
                  <Button size="sm" variant="ghost" onClick={() => setDoneDays((d) => d + 30)}>
                    Show older
                  </Button>
                </div>
              )
            }
            empty={
              status === "done"
                ? `Nothing done in the last ${doneDays} days.`
                : "Nothing here. Drag a todo in or use shift+h and shift+l."
            }
          />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {dragging && <MiniStrip todo={dragging} lifted aside={tookText(dragging)} />}
      </DragOverlay>
    </DndContext>
  );
}

function tookText(todo: Todo): string | undefined {
  return todo.status === "done" && todo.durationMs !== null
    ? `took ${formatDuration(todo.durationMs)}`
    : undefined;
}

function Column({
  status,
  todos,
  count,
  selectedId,
  onSelect,
  cursorHere,
  footer,
  empty,
}: {
  status: TodoStatus;
  todos: readonly Todo[];
  count: number;
  selectedId: number | null;
  onSelect: (id: number) => void;
  cursorHere: boolean;
  footer?: ReactNode;
  empty: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `column:${status}`, data: { status } });
  return (
    <section
      className={styles.column}
      data-status={status}
      data-over={isOver || undefined}
      data-cursor={cursorHere || undefined}
      aria-label={STATUS_LABELS[status]}
    >
      <header className={styles.columnHead}>
        <span className={styles.columnDot} aria-hidden="true" />
        <h2 className={styles.columnName}>{STATUS_LABELS[status]}</h2>
        <span className={styles.columnCount}>{count}</span>
      </header>
      <SortableContext items={todos.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <ol ref={setNodeRef} className={styles.cards}>
          {todos.map((todo) => (
            <Card
              key={todo.id}
              todo={todo}
              selected={todo.id === selectedId}
              onSelect={() => onSelect(todo.id)}
            />
          ))}
          {todos.length === 0 && <li className={styles.empty}>{empty}</li>}
        </ol>
      </SortableContext>
      {footer}
    </section>
  );
}

function Card({ todo, selected, onSelect }: { todo: Todo; selected: boolean; onSelect: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: todo.id,
    data: { status: todo.status },
  });
  // The board has its own keys (h, j, k, l, shift+h, shift+l), so the card is no extra tab stop or button.
  const { role: _role, tabIndex: _tabIndex, ...dragAttributes } = attributes;
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  return (
    <li className={styles.slot}>
      <MiniStrip
        ref={(node) => {
          setNodeRef(node);
          ref.current = node;
        }}
        todo={todo}
        selected={selected}
        ghost={isDragging}
        aside={tookText(todo)}
        onMouseDown={onSelect}
        style={{ transform: CSS.Translate.toString(transform), transition }}
        {...dragAttributes}
        {...listeners}
      />
    </li>
  );
}
