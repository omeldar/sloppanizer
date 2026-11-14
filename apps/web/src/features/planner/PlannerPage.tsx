import { addDays, toLocalTime, weekDays } from "@organizer/shared";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import {
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button, PageHeader } from "../../components/ui.tsx";
import { timeZone, today } from "../../lib/format.ts";
import { errorMessage } from "../../lib/api.ts";
import { useBlocks, useCreateBlock, useNext, useTodos, useUpdateBlock } from "../../lib/queries.ts";
import { useTodoDrag } from "./useTodoDrag.ts";
import { planDay, useAiSettings } from "../../lib/ai.ts";
import type { CheckedBlock } from "@organizer/shared";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import { BlockDialog, type BlockDraft, draftOf } from "./BlockDialog.tsx";
import styles from "./Planner.module.css";
import {
  blockSpan,
  blockTitle,
  minutesToTime,
  movedSpan,
  nextQuarter,
  type PlacedBlock,
  placeBlocks,
  snap,
  spanText,
  timeToMinutes,
  visibleHours,
} from "./planner.ts";

const route = getRouteApi("/planner");

/** A plan the assistant proposed for a day; blocks the user unticked are skipped. */
interface Proposal {
  day: string;
  note: string;
  blocks: CheckedBlock[];
  skipped: Set<number>;
}
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
 * free slot to plan time there, a block to change it; drag a todo from To plan or the Day row onto a
 * day to give it an hour there. Phones show one day at a time.
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
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const update = useUpdateBlock();
  const toast = useToast();
  const ai = useAiSettings();
  const aiOn = (ai.data?.provider ?? "none") !== "none";
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [planning, setPlanning] = useState(false);

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

  const create = useCreateBlock();
  const { drag, bind } = useTodoDrag({
    firstHour: hours.first,
    hourPx: HOUR_PX,
    onClick: (todo) => planTodo(todo),
    // A dropped todo gets an hour from where it landed; move or resize the block after.
    onDrop: (todo, day, startMin) =>
      create.mutate(
        {
          todoId: todo.id,
          ...blockSpan(
            day,
            minutesToTime(startMin),
            minutesToTime(Math.min(24 * 60, startMin + 60)),
            timeZone,
          ),
        },
        { onError: (failure) => toast.show({ tone: "error", message: errorMessage(failure) }) },
      ),
  });

  const askPlan = async () => {
    if (!ai.data) return;
    setPlanning(true);
    try {
      const result = await planDay(selected, ai.data);
      setProposal({ day: selected, note: result.note, blocks: result.blocks, skipped: new Set() });
      if (result.blocks.length === 0) toast.show({ message: result.note || "Nothing to plan for this day." });
    } catch (failure) {
      toast.show({ tone: "error", message: errorMessage(failure) });
    } finally {
      setPlanning(false);
    }
  };

  const acceptPlan = async () => {
    if (!proposal) return;
    const chosen = proposal.blocks.filter((b) => !proposal.skipped.has(b.todoId));
    for (const b of chosen) {
      // oxlint-disable-next-line no-await-in-loop -- one block after the other keeps the order and errors clear
      await create.mutateAsync({ todoId: b.todoId, ...blockSpan(proposal.day, b.start, b.end, timeZone) });
    }
    setProposal(null);
    toast.show({ message: `Planned ${chosen.length} block${chosen.length === 1 ? "" : "s"}` });
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
            {aiOn && (
              <Button size="sm" onClick={() => void askPlan()} disabled={planning}>
                {planning ? "Planning…" : "✦ Plan my day"}
              </Button>
            )}
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

      {proposal && proposal.blocks.length > 0 && (
        <div className={styles.proposalBar} role="region" aria-label="Proposed plan">
          <div className={styles.proposalText}>
            <strong>
              Proposed for {WEEKDAY.format(asDate(proposal.day))} {DAY_NUMBER.format(asDate(proposal.day))}:
            </strong>{" "}
            {proposal.note}
          </div>
          <ul className={styles.proposalList}>
            {proposal.blocks.map((b) => (
              <li key={b.todoId}>
                <label className={styles.proposalItem} title={b.why}>
                  <input
                    type="checkbox"
                    checked={!proposal.skipped.has(b.todoId)}
                    onChange={() => {
                      const skipped = new Set(proposal.skipped);
                      if (skipped.has(b.todoId)) skipped.delete(b.todoId);
                      else skipped.add(b.todoId);
                      setProposal({ ...proposal, skipped });
                    }}
                  />
                  <span className={styles.todayTime}>
                    {b.start}–{b.end}
                  </span>
                  <span className={styles.todayTitle}>{b.title}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className={styles.proposalActions}>
            <Button
              size="sm"
              variant="primary"
              onClick={() => void acceptPlan()}
              disabled={create.isPending || proposal.blocks.every((b) => proposal.skipped.has(b.todoId))}
            >
              Add to planner
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setProposal(null)}>
              Discard
            </Button>
          </div>
        </div>
      )}

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
                      title={`Drag into the day, or click to plan time for ${todo.title}`}
                      data-dragging={drag?.active && drag.todo.id === todo.id ? true : undefined}
                      {...bind(todo, { touch: true })}
                    >
                      {todo.title}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
          <div
            className={styles.body}
            onTouchStart={(event) => {
              const touch = event.touches[0];
              swipe.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
            }}
            onTouchEnd={(event) => {
              const from = swipe.current;
              const touch = event.changedTouches[0];
              swipe.current = null;
              if (!from || !touch) return;
              const dx = touch.clientX - from.x;
              const dy = touch.clientY - from.y;
              // A clear sideways swipe on a phone moves one day; scrolling stays vertical.
              if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5 && window.innerWidth <= 640) {
                go(addDays(selected, dx < 0 ? 1 : -1));
              }
            }}
          >
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
                {proposal?.day === day &&
                  proposal.blocks
                    .filter((b) => !proposal.skipped.has(b.todoId))
                    .map((b) => (
                      <span
                        key={`p-${b.todoId}`}
                        className={styles.proposed}
                        style={{
                          top: ((timeToMinutes(b.start) - hours.first * 60) / 60) * HOUR_PX,
                          height: ((timeToMinutes(b.end) - timeToMinutes(b.start)) / 60) * HOUR_PX - 2,
                        }}
                        title={b.why}
                      >
                        <span className={styles.blockTitle}>{b.title}</span>
                        <span className={styles.blockTime}>
                          {b.start}–{b.end}
                        </span>
                      </span>
                    ))}
                {drag?.active && drag.target?.day === day && (
                  <span
                    className={styles.dropPreview}
                    style={{
                      top: ((drag.target.startMin - hours.first * 60) / 60) * HOUR_PX,
                      height: HOUR_PX - 2,
                    }}
                    aria-hidden="true"
                  >
                    {minutesToTime(drag.target.startMin)} {drag.todo.title}
                  </span>
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
                <button
                  type="button"
                  className={styles.toPlanItem}
                  title="Drag onto the calendar, or click to plan time"
                  data-dragging={drag?.active && drag.todo.id === todo.id ? true : undefined}
                  {...bind(todo)}
                >
                  <span className={styles.toPlanTitle}>{todo.title}</span>
                  <span className={styles.toPlanAction}>Plan</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
      </div>

      {drag?.active && (
        <div className={styles.ghost} style={{ left: drag.x + 12, top: drag.y + 12 }} aria-hidden="true">
          {drag.todo.title}
        </div>
      )}
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
 * resizes it, both in 15 minute steps; a click without moving opens it. On touch screens a long press
 * picks it up (move, or resize near the bottom edge) and a tap opens it.
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

  // Touch: a long press picks the block up (near its bottom edge: resizes it), then it follows the
  // finger in 15 minute steps; a quick swipe still scrolls and a tap opens it. Native listeners, because
  // only a non-passive touchmove can stop the page from scrolling once the drag has started.
  const ref = useRef<HTMLButtonElement>(null);
  const dropRef = useRef(onDrop);
  useEffect(() => {
    dropRef.current = onDrop;
  }, [onDrop]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    let timer: number | undefined;
    let origin: { x: number; y: number } | null = null;
    let active: Drag | null = null;
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch) return;
      origin = { x: touch.clientX, y: touch.clientY };
      const mode = touch.clientY > el.getBoundingClientRect().bottom - 16 ? "resize" : "move";
      timer = window.setTimeout(() => {
        if (!origin) return;
        active = { mode, x: origin.x, y: origin.y, colWidth: 0, moved: true, deltaMin: 0, dayOffset: 0 };
        navigator.vibrate?.(10);
        setDrag(active);
      }, 350);
    };
    const onMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch || !origin) return;
      if (!active) {
        if (Math.hypot(touch.clientX - origin.x, touch.clientY - origin.y) > 8) {
          window.clearTimeout(timer);
          origin = null;
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      active = { ...active, deltaMin: snap(((touch.clientY - active.y) / HOUR_PX) * 60) };
      setDrag(active);
    };
    const onEnd = (event: TouchEvent) => {
      window.clearTimeout(timer);
      origin = null;
      if (!active) return;
      // Neither a click (opening the block) nor the day swipe of the calendar.
      event.preventDefault();
      event.stopPropagation();
      const done = active;
      active = null;
      setDrag(null);
      if (done.deltaMin !== 0) dropRef.current(done.deltaMin, 0, done.mode);
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      window.clearTimeout(timer);
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, []);

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
      ref={ref}
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
