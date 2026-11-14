import { addDays, toLocalTime, weekDays } from "@organizer/shared";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { type CSSProperties, type MouseEvent, type PointerEvent, useEffect, useMemo, useState } from "react";
import { Button, PageHeader } from "../../components/ui.tsx";
import { timeZone, today } from "../../lib/format.ts";
import { errorMessage } from "../../lib/api.ts";
import { useBlocks, useNext, useTodos, useUpdateBlock } from "../../lib/queries.ts";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import { BlockDialog, type BlockDraft, draftOf } from "./BlockDialog.tsx";
import styles from "./Planner.module.css";
import {
  blockTitle,
  minutesToTime,
  movedSpan,
  nextQuarter,
  type PlacedBlock,
  placeBlocks,
  snap,
  spanText,
  visibleHours,
} from "./planner.ts";

const route = getRouteApi("/planner");
const HOUR_PX = 52;
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" });
const DAY_NUMBER = new Intl.DateTimeFormat(undefined, { day: "numeric", timeZone: "UTC" });
const MONTH = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

const asDate = (day: string) => new Date(`${day}T12:00:00Z`);

/** Today and the minutes after local midnight now. */
function readNow(): { day: string; minutes: number } {
  const now = new Date();
  const [h = 0, m = 0] = toLocalTime(now, timeZone).split(":").map(Number);
  return { day: today(now), minutes: h * 60 + m };
}

/** readNow, refreshed every minute (for the now line). */
function useNowMinutes(): { day: string; minutes: number } {
  const [state, setState] = useState(readNow);
  useEffect(() => {
    const timer = setInterval(() => setState(readNow()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return state;
}

/**
 * The planner: a week of days with time blocks for todos (or with their own title). Click or tap a
 * free slot to plan time there, a block to change it. Phones show one day at a time.
 */
export function PlannerPage() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const now = useNowMinutes();
  const selected = search.day ?? now.day;
  const days = useMemo(() => weekDays(selected, timeZone), [selected]);
  const first = days[0] as string;
  const last = days[6] as string;
  const blocks = useBlocks(first, last);
  const plannedTodos = useTodos({
    plannedFrom: first,
    plannedTo: last,
    sort: "priority",
    order: "desc",
    limit: 200,
  });
  const next = useNext({ mode: "smart" });
  const [draft, setDraft] = useState<BlockDraft | null>(null);
  const update = useUpdateBlock();
  const toast = useToast();

  const go = (day: string) => void navigate({ to: "/planner", search: day === now.day ? {} : { day } });

  const placedByDay = useMemo(
    () => new Map(days.map((day) => [day, placeBlocks(blocks.data ?? [], day, timeZone)])),
    [blocks.data, days],
  );
  const hours = visibleHours([...placedByDay.values()].flat());
  const hourList = Array.from({ length: hours.last - hours.first }, (_, i) => hours.first + i);
  const gridStyle = { "--hour": `${HOUR_PX}px`, "--hours": hourList.length } as CSSProperties;

  const planAt = (day: string, event: MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const minutes = snap(hours.first * 60 + ((event.clientY - rect.top) / HOUR_PX) * 60 - 15);
    const start = Math.max(0, Math.min(23 * 60, minutes));
    setDraft({ day, start: minutesToTime(start), end: minutesToTime(Math.min(24 * 60, start + 60)) });
  };

  const planTodo = (todo: { id: number; title: string }, day = selected) => {
    const start = day === now.day ? nextQuarter(new Date(), timeZone) : "09:00";
    const [h = 9, m = 0] = start.split(":").map(Number);
    setDraft({ day, start, end: minutesToTime(Math.min(24 * 60, h * 60 + m + 60)), todo });
  };

  const planned = new Set((blocks.data ?? []).flatMap((b) => (b.todoId === null ? [] : [b.todoId])));
  const toPlan = (next.data?.items ?? [])
    .map((item) => item.todo)
    .filter((todo) => !planned.has(todo.id))
    .slice(0, 8);
  /** Todos planned for a day of this week that have no time that day yet. */
  const dayTodos = (day: string) =>
    (plannedTodos.data?.items ?? []).filter(
      (todo) =>
        todo.plannedOn === day && !(placedByDay.get(day) ?? []).some((p) => p.block.todoId === todo.id),
    );

  return (
    <div className={styles.page}>
      <PageHeader
        title="Planner"
        meta={`${MONTH.format(asDate(first))} – ${MONTH.format(asDate(last))}`}
        actions={
          <>
            <Button size="sm" onClick={() => go(addDays(selected, -7))} aria-label="Previous week">
              ‹
            </Button>
            <Button size="sm" onClick={() => go(now.day)}>
              Today
            </Button>
            <Button size="sm" onClick={() => go(addDays(selected, 7))} aria-label="Next week">
              ›
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                const start = selected === now.day ? nextQuarter(new Date(), timeZone) : "09:00";
                const [h = 9, m = 0] = start.split(":").map(Number);
                setDraft({ day: selected, start, end: minutesToTime(Math.min(24 * 60, h * 60 + m + 60)) });
              }}
            >
              Plan time
            </Button>
          </>
        }
      />

      <div className={styles.layout}>
        <div className={styles.calendar} style={gridStyle}>
          <div className={styles.dayHeads} role="tablist" aria-label="Days">
            <span className={styles.corner} />
            {days.map((day) => (
              <button
                key={day}
                type="button"
                role="tab"
                aria-selected={day === selected}
                className={styles.dayHead}
                data-today={day === now.day || undefined}
                data-selected={day === selected || undefined}
                onClick={() => go(day)}
              >
                <span className={styles.weekday}>{WEEKDAY.format(asDate(day))}</span>
                <span className={styles.dayNumber}>{DAY_NUMBER.format(asDate(day))}</span>
                {(placedByDay.get(day)?.length ?? 0) > 0 && (
                  <span className={styles.dot} aria-hidden="true" />
                )}
              </button>
            ))}
          </div>
          {days.some((day) => dayTodos(day).length > 0) && (
            <div className={styles.allDay} aria-label="Planned for the day, no time yet">
              <span className={styles.allDayLabel}>Day</span>
              {days.map((day) => (
                <div key={day} className={styles.allDayCell} data-selected={day === selected || undefined}>
                  {dayTodos(day).map((todo) => (
                    <button
                      key={todo.id}
                      type="button"
                      className={styles.dayTodo}
                      title={`Plan time for ${todo.title}`}
                      onClick={() => planTodo(todo, day)}
                    >
                      {todo.title}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
          <div className={styles.body}>
            <div className={styles.axis} aria-hidden="true">
              {hourList.map((hour) => (
                <span key={hour} className={styles.hourLabel}>
                  {minutesToTime(hour * 60)}
                </span>
              ))}
            </div>
            {days.map((day, dayIndex) => (
              <div
                key={day}
                data-day={day}
                className={styles.day}
                data-selected={day === selected || undefined}
                data-past={day < now.day || undefined}
                onClick={(event) => planAt(day, event)}
                role="presentation"
              >
                {day === now.day && now.minutes >= hours.first * 60 && now.minutes <= hours.last * 60 && (
                  <span
                    className={styles.nowLine}
                    style={{ top: ((now.minutes - hours.first * 60) / 60) * HOUR_PX }}
                    aria-hidden="true"
                  />
                )}
                {(placedByDay.get(day) ?? []).map((placed) => (
                  <BlockCard
                    key={`${placed.block.id}-${day}`}
                    placed={placed}
                    firstHour={hours.first}
                    dayIndex={dayIndex}
                    dayCount={days.length}
                    onOpen={() => setDraft(draftOf(placed.block))}
                    onDrop={(deltaMin, dayOffset, mode) =>
                      update.mutate(
                        {
                          id: placed.block.id,
                          patch: movedSpan(placed.block, deltaMin, dayOffset, mode, timeZone),
                        },
                        {
                          onError: (failure) => toast.show({ tone: "error", message: errorMessage(failure) }),
                        },
                      )
                    }
                  />
                ))}
              </div>
            ))}
          </div>
        </div>

        <aside className={styles.side} aria-label="To plan">
          <h2 className={styles.sideTitle}>To plan</h2>
          <p className={styles.sideNote}>Next up without time this week.</p>
          {toPlan.length === 0 && (
            <p className={styles.sideNote}>Everything near the top has time planned.</p>
          )}
          <ul className={styles.toPlan}>
            {toPlan.map((todo) => (
              <li key={todo.id}>
                <button type="button" className={styles.toPlanItem} onClick={() => planTodo(todo)}>
                  <span className={styles.toPlanTitle}>{todo.title}</span>
                  <span className={styles.toPlanAction}>Plan</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
      </div>

      <BlockDialog draft={draft} onClose={() => setDraft(null)} />
    </div>
  );
}

interface Drag {
  mode: "move" | "resize";
  x: number;
  y: number;
  /** Width of a day column, for moving across days. */
  colWidth: number;
  moved: boolean;
  deltaMin: number;
  dayOffset: number;
}

/**
 * One block. With a mouse it can be dragged: the body moves it (also to another day), the bottom edge
 * resizes it, both in 15 minute steps; a click without moving opens it. Touch screens tap to open.
 */
function BlockCard({
  placed,
  firstHour,
  dayIndex,
  dayCount,
  onOpen,
  onDrop,
}: {
  placed: PlacedBlock;
  firstHour: number;
  dayIndex: number;
  dayCount: number;
  onOpen: () => void;
  onDrop: (deltaMin: number, dayOffset: number, mode: "move" | "resize") => void;
}) {
  const { block } = placed;
  const [drag, setDrag] = useState<Drag | null>(null);
  const baseTop = ((placed.startMin - firstHour * 60) / 60) * HOUR_PX;
  const baseHeight = Math.max(22, ((placed.endMin - placed.startMin) / 60) * HOUR_PX - 2);
  const deltaPx = drag ? (drag.deltaMin / 60) * HOUR_PX : 0;
  const top = drag?.mode === "move" ? baseTop + deltaPx : baseTop;
  const height = drag?.mode === "resize" ? Math.max(HOUR_PX / 4 - 2, baseHeight + deltaPx) : baseHeight;

  const start = (event: PointerEvent<HTMLElement>, mode: Drag["mode"]) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const column = (event.currentTarget.closest("[data-day]") as HTMLElement | null)?.offsetWidth ?? 0;
    setDrag({
      mode,
      x: event.clientX,
      y: event.clientY,
      colWidth: column,
      moved: false,
      deltaMin: 0,
      dayOffset: 0,
    });
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    const moved = drag.moved || Math.abs(dx) > 4 || Math.abs(dy) > 4;
    const deltaMin = snap((dy / HOUR_PX) * 60);
    const offset = drag.mode === "move" && drag.colWidth > 0 ? Math.round(dx / drag.colWidth) : 0;
    const dayOffset = Math.max(-dayIndex, Math.min(dayCount - 1 - dayIndex, offset));
    setDrag({ ...drag, moved, deltaMin, dayOffset });
  };
  const end = () => {
    if (!drag) return;
    setDrag(null);
    if (!drag.moved) {
      if (drag.mode === "move") onOpen();
      return;
    }
    if (drag.deltaMin !== 0 || drag.dayOffset !== 0) onDrop(drag.deltaMin, drag.dayOffset, drag.mode);
  };

  const style = {
    top,
    height,
    transform: drag?.dayOffset ? `translateX(${drag.dayOffset * drag.colWidth}px)` : undefined,
    // Overlaps cascade like a calendar: each later lane is indented and drawn on top, so every block
    // keeps most of the column's width.
    left: `calc(${placed.lane * Math.min(28, 60 / placed.lanes)}% + 2px)`,
    right: "2px",
    zIndex: 1 + placed.lane,
    "--block": block.project?.color ?? "var(--amber)",
  } as CSSProperties;
  return (
    <button
      type="button"
      className={styles.block}
      style={style}
      data-done={block.todo?.status === "done" || undefined}
      data-short={height < 40 || undefined}
      data-dragging={drag?.moved || undefined}
      onPointerDown={(event) => start(event, "move")}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={() => setDrag(null)}
      // Keyboard and touch: a click opens the block (a mouse click is handled on pointer up).
      onClick={(event) => {
        if (event.detail === 0 || !matchesMouse(event)) onOpen();
      }}
      title={`${blockTitle(block)}, ${spanText(block, timeZone)}`}
    >
      <span className={styles.blockTitle}>{blockTitle(block)}</span>
      <span className={styles.blockTime}>{spanText(block, timeZone)}</span>
      {!placed.continuesAfter && (
        <span
          className={styles.resize}
          aria-hidden="true"
          onPointerDown={(event) => start(event, "resize")}
          onPointerMove={move}
          onPointerUp={end}
        />
      )}
    </button>
  );
}

/** Whether a click came from a mouse (pointer events already handled it). */
const matchesMouse = (event: MouseEvent<HTMLElement>): boolean =>
  (event.nativeEvent as globalThis.PointerEvent).pointerType === "mouse";
