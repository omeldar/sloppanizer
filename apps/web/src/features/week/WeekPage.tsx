import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { addDays, type Space, type Todo, type UpdateTodo } from "@organizer/shared";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useRef, useState } from "react";
import { useCurrentAccount } from "../../app/account.tsx";
import { MiniStrip } from "../../components/strip/MiniStrip.tsx";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import { Announce, Button, ErrorState, Kbd, Loading, PageHeader } from "../../components/ui.tsx";
import { type KeyBinding, useKeys } from "../../keyboard/KeyboardProvider.tsx";
import { formatDate, formatDayMonth, today, tookText, weekdayName } from "../../lib/format.ts";
import { errorMessage } from "../../lib/api.ts";
import { useTodos } from "../../lib/queries.ts";
import { sharedKey, sharedTodoHref, useSharedTodos, useUpdateSharedTodo } from "../../lib/spaces.ts";
import { useScrollIntoView } from "../../lib/listCursor.ts";
import { useTodoActions } from "../todos/useTodoActions.ts";
import { daysOfWeek, shiftWeek, weekPlace, weekStart } from "./week.ts";
import styles from "./Week.module.css";

const route = getRouteApi("/week");

const UNPLANNED = "unplanned";

/** "Wed 18.11.2026" for labels, announcements and toasts. */
function dayText(date: string): string {
  return `${weekdayName(date)} ${formatDate(date)}`;
}

/**
 * A todo on the week board: your own, or one assigned to you in a shared project (`space`), whose id is
 * counted there, so the board tells them apart by `weekKey`.
 */
export type WeekTodo = Todo & { space?: Space };

export const weekKey = (todo: Pick<WeekTodo, "id" | "space">): string =>
  todo.space ? sharedKey(todo.space.id, todo.id) : String(todo.id);

/** A shared project's todos as week board todos. */
const withSpace = (list: { space: Space; todo: Todo }[]): WeekTodo[] =>
  list.map(({ space, todo }) => ({ ...todo, space }));

interface Lists {
  days: Map<string, WeekTodo[]>;
  carried: WeekTodo[];
  unplanned: WeekTodo[];
}

/** Sorts the loaded todos into the seven days and the two side lists, with unsaved moves applied. */
export function weekLists(
  todos: readonly WeekTodo[],
  days: readonly string[],
  overrides: ReadonlyMap<string, string | null> = new Map(),
): Lists {
  const lists: Lists = { days: new Map(days.map((d) => [d, []])), carried: [], unplanned: [] };
  const seen = new Set<string>();
  for (const todo of todos) {
    const key = weekKey(todo);
    if (seen.has(key)) continue;
    seen.add(key);
    const shown = overrides.has(key) ? { ...todo, plannedOn: overrides.get(key) ?? null } : todo;
    const place = weekPlace(shown, days);
    if (place?.kind === "day") lists.days.get(place.date)?.push(shown);
    else if (place?.kind === "carried") lists.carried.push(shown);
    else if (place?.kind === "unplanned") lists.unplanned.push(shown);
  }
  return lists;
}

export function WeekPage() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const now = today();
  const start = weekStart(search.start, now);
  const days = daysOfWeek(start);
  const end = days[6] as string;
  const goWeek = (to: string) =>
    void navigate({ to: "/week", search: to === weekStart(undefined, now) ? {} : { start: to } });

  useKeys([
    { keys: "[", run: () => goWeek(shiftWeek(start, -1)), label: "Previous week", group: "Week" },
    { keys: "]", run: () => goWeek(shiftWeek(start, 1)), label: "Next week", group: "Week" },
    { keys: "PageUp", run: () => goWeek(shiftWeek(start, -1)), label: "Previous week", group: "Week" },
    { keys: "PageDown", run: () => goWeek(shiftWeek(start, 1)), label: "Next week", group: "Week" },
    { keys: "t", run: () => goWeek(weekStart(undefined, now)), label: "This week", group: "Week" },
  ]);

  return (
    <>
      <PageHeader
        title="Week"
        meta={
          <span className={styles.range}>
            {formatDate(start)} to {formatDate(end)}
          </span>
        }
        actions={
          <div className={styles.nav}>
            <Button size="sm" hint="[" onClick={() => goWeek(shiftWeek(start, -1))}>
              Previous week
            </Button>
            <Button size="sm" hint="t" onClick={() => goWeek(weekStart(undefined, now))}>
              This week
            </Button>
            <Button size="sm" hint="]" onClick={() => goWeek(shiftWeek(start, 1))}>
              Next week
            </Button>
          </div>
        }
      />
      <WeekBoard key={start} days={days} today={now} />
    </>
  );
}

function WeekBoard({ days, today: now }: { days: string[]; today: string }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { patch: patchOwn, toggleDone: toggleOwn } = useTodoActions();
  const updateShared = useUpdateSharedTodo();
  const account = useCurrentAccount();
  const start = days[0] as string;
  const end = days[6] as string;

  const planned = useTodos({
    status: "all",
    plannedFrom: start,
    plannedTo: end,
    sort: "priority",
    order: "desc",
    limit: 500,
  });
  const carried = useTodos({ plannedTo: addDays(start, -1), sort: "priority", order: "desc", limit: 200 });
  const unplanned = useTodos({ unplanned: "true", sort: "priority", order: "desc", limit: 200 });
  // The same three lists from your shared projects: the todos assigned to you there (your own tab).
  const sharedPlanned = useSharedTodos({
    status: "all",
    plannedFrom: start,
    plannedTo: end,
    sort: "priority",
    order: "desc",
    limit: 200,
  });
  const sharedCarried = useSharedTodos({
    plannedTo: addDays(start, -1),
    sort: "priority",
    order: "desc",
    limit: 100,
  });
  const sharedUnplanned = useSharedTodos({ unplanned: "true", sort: "priority", order: "desc", limit: 100 });

  const [overrides, setOverrides] = useState<Map<string, string | null>>(new Map());
  const lists = weekLists(
    [
      ...(planned.data?.items ?? []),
      ...withSpace(sharedPlanned.items),
      ...(carried.data?.items ?? []),
      ...withSpace(sharedCarried.items),
      ...(unplanned.data?.items ?? []),
      ...withSpace(sharedUnplanned.items),
    ],
    days,
    overrides,
  );
  // Cursor columns: the seven days, then the side panel (carried over, then unplanned).
  const columns: WeekTodo[][] = [
    ...days.map((d) => lists.days.get(d) ?? []),
    [...lists.carried, ...lists.unplanned],
  ];
  const [cursor, setCursor] = useState<{ col: number; id: string | null }>({
    col: Math.max(0, days.indexOf(now)),
    id: null,
  });
  const [dragging, setDragging] = useState<WeekTodo | null>(null);
  const lastDrag = useRef(0);

  const locate = (id: string | null) => {
    if (id === null) return null;
    for (const [col, list] of columns.entries()) {
      const row = list.findIndex((t) => weekKey(t) === id);
      if (row !== -1) return { col, row, todo: list[row] as WeekTodo };
    }
    return null;
  };
  const selected = locate(cursor.id);

  /** "#12" for your own todos; a shared project's todo by its title (its number is counted there). */
  const named = (todo: WeekTodo) => (todo.space ? `"${todo.title}"` : `#${todo.id}`);

  /** Saves a change: your own todos as always, a shared one in its project (planning it assigns it to you). */
  const patch = async (todo: WeekTodo, change: UpdateTodo): Promise<Todo | null> => {
    if (!todo.space) return patchOwn(todo.id, change);
    try {
      return await updateShared.mutateAsync({ spaceId: todo.space.id, todoId: todo.id, patch: change });
    } catch (failure) {
      toast.show({ tone: "error", message: `Could not change "${todo.title}". ${errorMessage(failure)}` });
      return null;
    }
  };

  const toggleDone = async (todo: WeekTodo) => {
    if (!todo.space) return toggleOwn(todo);
    const previous = todo.status;
    const status = previous === "done" ? "open" : "done";
    if (!(await patch(todo, { status }))) return;
    toast.show({
      message: status === "done" ? `Marked "${todo.title}" done` : `Reopened "${todo.title}"`,
      action: { label: "Undo", run: () => void patch(todo, { status: previous }) },
    });
  };

  const plan = async (todo: WeekTodo, plannedOn: string | null) => {
    const before = todo.plannedOn;
    if (before === plannedOn) return;
    const key = weekKey(todo);
    setOverrides((current) => new Map(current).set(key, plannedOn));
    const saved = await patch(todo, { plannedOn });
    setOverrides((current) => {
      const next = new Map(current);
      next.delete(key);
      return next;
    });
    if (!saved) return;
    // Planning a shared project's todo nobody was on gave it to you; someone else's stays theirs.
    const assignee =
      todo.space && plannedOn && saved.assignee?.username !== account?.username ? saved.assignee : null;
    toast.show({
      message: plannedOn
        ? `Planned ${named(todo)} for ${dayText(plannedOn)}${assignee ? `; it stays assigned to ${assignee.name}` : ""}`
        : `Unplanned ${named(todo)}`,
      action: { label: "Undo", run: () => void patch(todo, { plannedOn: before }) },
    });
  };

  const open = (todo: WeekTodo) => {
    if (todo.space && account)
      window.location.assign(sharedTodoHref(account.username, todo.space.id, todo.id));
    else void navigate({ to: "/todos/$id", params: { id: String(todo.id) } });
  };

  const step = (dc: number, dr: number) => {
    const col = Math.max(0, Math.min(columns.length - 1, (selected?.col ?? cursor.col) + dc));
    const list = columns[col] ?? [];
    const row = selected ? (dc === 0 ? selected.row + dr : selected.row) : dr < 0 ? list.length - 1 : 0;
    const target = list[Math.max(0, Math.min(list.length - 1, row))];
    setCursor({ col, id: target ? weekKey(target) : null });
  };

  /** A day earlier or later; from the side panel, shift+h plans it for Sunday (the column to its left). */
  const shiftDay = (delta: number) => {
    if (!selected) return;
    if (selected.col === 7) {
      if (delta < 0) void plan(selected.todo, end);
      return;
    }
    const date = selected.todo.plannedOn;
    if (date) void plan(selected.todo, addDays(date, delta));
  };

  const bindings: KeyBinding[] = [
    { keys: "h", run: () => step(-1, 0), label: "Day to the left", group: "Week" },
    { keys: "l", run: () => step(1, 0), label: "Day to the right", group: "Week" },
    { keys: "j", run: () => step(0, 1), label: "Next todo of the day", group: "Week" },
    { keys: "k", run: () => step(0, -1), label: "Previous todo of the day", group: "Week" },
    { keys: "ArrowLeft", run: () => step(-1, 0) },
    { keys: "ArrowRight", run: () => step(1, 0) },
    { keys: "ArrowDown", run: () => step(0, 1) },
    { keys: "ArrowUp", run: () => step(0, -1) },
    { keys: "shift+h", run: () => shiftDay(-1), label: "Plan a day earlier", group: "Week" },
    { keys: "shift+l", run: () => shiftDay(1), label: "Plan a day later", group: "Week" },
    {
      keys: "Backspace",
      run: () => selected && void plan(selected.todo, null),
      label: "Unplan the todo",
      group: "Week",
    },
    {
      keys: "Enter",
      run: () => selected && open(selected.todo),
      label: "Open todo",
      group: "Week",
    },
    {
      keys: "x",
      run: () => selected && void toggleDone(selected.todo),
      label: "Mark done or reopen",
      group: "Week",
    },
  ];
  useKeys(bindings);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    // oxlint-disable-next-line react/purity -- runs in the drag end handler, not during render
    lastDrag.current = Date.now();
    const found = locate(String(active.id));
    if (!found || !over) return;
    const target = String(over.id);
    void plan(found.todo, target === UNPLANNED ? null : target);
  };

  if (planned.isPending) return <Loading />;
  if (planned.isError) return <ErrorState error={planned.error} onRetry={() => void planned.refetch()} />;

  const card = (todo: WeekTodo, narrow = true) => {
    const key = weekKey(todo);
    return (
      <DraggableStrip
        key={key}
        id={key}
        todo={todo}
        href={todo.space && account ? sharedTodoHref(account.username, todo.space.id, todo.id) : null}
        selected={key === cursor.id}
        narrow={narrow}
        onSelect={() => setCursor({ col: locate(key)?.col ?? cursor.col, id: key })}
      />
    );
  };
  const sideCard = (todo: WeekTodo) => card(todo, false);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={(event) => setDragging(locate(String(event.active.id))?.todo ?? null)}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      <div
        className={styles.week}
        onClickCapture={(event) => {
          if (Date.now() - lastDrag.current < 250) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        <Announce
          text={
            selected
              ? `${selected.todo.space ? `${selected.todo.space.name}: ` : `#${selected.todo.id} `}${selected.todo.title}, ${
                  days[selected.col] ? dayText(days[selected.col] as string) : "not planned this week"
                }`
              : ""
          }
        />
        <div className={styles.days}>
          {days.map((date, col) => (
            <DropZone
              key={date}
              id={date}
              className={styles.day}
              data={{
                "data-today": date === now || undefined,
                "data-past": date < now || undefined,
                "data-cursor": (cursor.col === col && cursor.id === null) || undefined,
              }}
              label={dayText(date)}
              head={
                <>
                  <span className={styles.dayName}>{weekdayName(date)}</span>
                  <span className={styles.dayDate}>{formatDayMonth(date)}</span>
                  <span className={styles.dayCount}>{lists.days.get(date)?.length || ""}</span>
                </>
              }
            >
              {(lists.days.get(date) ?? []).map((todo) => card(todo))}
            </DropZone>
          ))}
        </div>
        <aside className={styles.side} aria-label="Not planned this week">
          <section className={styles.sideList} aria-label="Carried over">
            <h2 className={styles.dayHead}>
              Carried over <span className={styles.dayCount}>{lists.carried.length || ""}</span>
            </h2>
            <ol className={styles.cards}>
              {lists.carried.map(sideCard)}
              {lists.carried.length === 0 && (
                <li className={styles.empty}>Nothing left over from earlier weeks.</li>
              )}
            </ol>
          </section>
          <DropZone
            id={UNPLANNED}
            className={styles.sideList}
            label="Unplanned"
            head={
              <>
                Unplanned <span className={styles.dayCount}>{lists.unplanned.length || ""}</span>
              </>
            }
          >
            {lists.unplanned.map(sideCard)}
            {lists.unplanned.length === 0 && <li className={styles.empty}>Every open todo has a day.</li>}
          </DropZone>
          <p className={styles.keysHint}>
            <Kbd keys="shift+h" />
            <Kbd keys="shift+l" /> a day earlier or later, <Kbd keys="Backspace" /> unplan
          </p>
        </aside>
      </div>
      <DragOverlay dropAnimation={null}>{dragging && <MiniStrip todo={dragging} lifted />}</DragOverlay>
    </DndContext>
  );
}

function DropZone({
  id,
  className,
  label,
  head,
  data,
  children,
}: {
  id: string;
  className?: string;
  label: string;
  head: ReactNode;
  data?: Record<string, true | undefined>;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <section
      ref={setNodeRef}
      className={className}
      data-over={isOver || undefined}
      aria-label={label}
      {...data}
    >
      <h2 className={styles.dayHead}>{head}</h2>
      <ol className={styles.cards}>{children}</ol>
    </section>
  );
}

function DraggableStrip({
  id,
  todo,
  href,
  selected,
  narrow,
  onSelect,
}: {
  id: string;
  todo: WeekTodo;
  /** A shared project's todo: where it opens (that project's tab). */
  href: string | null;
  selected: boolean;
  narrow: boolean;
  onSelect: () => void;
}) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id });
  const { role: _role, tabIndex: _tabIndex, ...dragAttributes } = attributes;
  const ref = useScrollIntoView<HTMLDivElement>(selected);
  const took = tookText(todo);
  return (
    <li className={styles.slot}>
      <MiniStrip
        ref={(node) => {
          setNodeRef(node);
          ref.current = node;
        }}
        todo={todo}
        {...(todo.space
          ? { source: { name: todo.space.name, color: todo.space.color, href: href ?? "" } }
          : {})}
        selected={selected}
        ghost={isDragging}
        aside={took}
        narrow={narrow}
        onMouseDown={onSelect}
        {...dragAttributes}
        {...listeners}
      />
    </li>
  );
}
