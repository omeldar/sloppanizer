import { addDays, type MeetingOccurrence, type SeriesScope, toLocalTime, weekDays } from "@organizer/shared";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import {
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button, PageHeader } from "../../components/ui.tsx";
import { dayLabel, formatDate, formatDayMonth, timeZone, today, weekdayName } from "../../lib/format.ts";
import { errorMessage } from "../../lib/api.ts";
import { useBlocks, useCreateBlock, useNext, useTodos, useUpdateBlock } from "../../lib/queries.ts";
import { useChangeOccurrence, useDeleteMeeting, useMeetings, useOccurrences } from "../../lib/meetings.ts";
import { SeriesScopeDialog } from "../../components/SeriesScopeDialog.tsx";
import { OccurrenceDialog } from "./OccurrenceDialog.tsx";
import { useEdgeScroll } from "./useEdgeScroll.ts";
import { useTodoDrag } from "./useTodoDrag.ts";
import { planDay, useAiSettings } from "../../lib/ai.ts";
import type { CheckedBlock } from "@organizer/shared";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import { useKeys } from "../../keyboard/KeyboardProvider.tsx";
import { BlockDialog, type BlockDraft, draftOf } from "./BlockDialog.tsx";
import styles from "./Planner.module.css";
import {
  blockItem,
  blockSpan,
  blockTitle,
  MEETING_CANCEL_SCOPES,
  meetingItem,
  meetingMoveScopes,
  minutesToTime,
  movedSpan,
  nextQuarter,
  type Placed,
  placeItems,
  scrollStartMinutes,
  snap,
  spanText,
  timeToMinutes,
} from "./planner.ts";

const route = getRouteApi("/planner");

/** A plan the assistant proposed for a day; blocks the user unticked are skipped. */
interface Proposal {
  day: string;
  note: string;
  blocks: CheckedBlock[];
  skipped: Set<number>;
}
/** A meeting date change waiting for "this one, following or all". */
type MeetingChange =
  | { action: "move"; occurrence: MeetingOccurrence; startAt: string; endAt: string }
  | { action: "cancel"; occurrence: MeetingOccurrence };

/** The grid always shows the whole day; it scrolls inside itself. */
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const HOUR_PX = 52;

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

const GRID_STYLE = { "--hour": `${HOUR_PX}px`, "--hours": HOURS.length } as CSSProperties;

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
  const occurrences = useOccurrences({ from: first, to: last });
  const meetings = useMeetings();
  const [openMeeting, setOpenMeeting] = useState<MeetingOccurrence | null>(null);
  const [meetingChange, setMeetingChange] = useState<MeetingChange | null>(null);
  const [changeError, setChangeError] = useState<string | null>(null);
  const changeOccurrence = useChangeOccurrence();
  const deleteMeeting = useDeleteMeeting();
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
  useKeys([
    { keys: "PageUp", run: () => go(addDays(selected, -7)), label: "Previous week", group: "Planner" },
    { keys: "PageDown", run: () => go(addDays(selected, 7)), label: "Next week", group: "Planner" },
  ]);

  const placedByDay = useMemo(() => {
    const items = [
      ...(blocks.data ?? []).map(blockItem),
      ...(occurrences.data ?? [])
        .filter((o) => o.status !== "cancelled")
        .map((o) =>
          // A dropped meeting stays where it was dropped while the scope is asked.
          meetingChange?.action === "move" &&
          meetingChange.occurrence.meetingId === o.meetingId &&
          meetingChange.occurrence.occursOn === o.occursOn
            ? meetingItem(o, meetingChange)
            : meetingItem(o),
        ),
    ];
    return new Map(days.map((day) => [day, placeItems(items, day, timeZone)]));
  }, [blocks.data, occurrences.data, meetingChange, days]);
  // The grid scrolls inside itself; it opens near now on this week, at the start of the day on others.
  const body = useRef<HTMLDivElement>(null);
  const [openAt] = useState(() => scrollStartMinutes(days.includes(now.day), now.minutes));
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = (openAt / 60) * HOUR_PX;
  }, [openAt]);

  const planAt = (day: string, event: MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const minutes = snap(((event.clientY - rect.top) / HOUR_PX) * 60 - 15);
    const start = Math.max(0, Math.min(23 * 60, minutes));
    setDraft({ day, start: minutesToTime(start), end: minutesToTime(Math.min(24 * 60, start + 60)) });
  };

  const planTodo = (todo: { id: number; title: string }, day = selected) => {
    const start = day === now.day ? nextQuarter(new Date(), timeZone) : "09:00";
    const [h = 9, m = 0] = start.split(":").map(Number);
    setDraft({ day, start, end: minutesToTime(Math.min(24 * 60, h * 60 + m + 60)), todo });
  };

  const create = useCreateBlock();
  const { drag, bind, retarget } = useTodoDrag({
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
  useEdgeScroll(body, drag?.active ? drag : null);

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

  const applyMeetingChange = (pending: MeetingChange, scope: SeriesScope) => {
    const { occurrence } = pending;
    if (pending.action === "cancel" && scope === "all") {
      deleteMeeting.mutate(occurrence.meetingId, {
        onSuccess: () => {
          setMeetingChange(null);
          toast.show({ message: `Deleted ${occurrence.name}` });
        },
        onError: (failure) => setChangeError(errorMessage(failure)),
      });
      return;
    }
    const change =
      pending.action === "move"
        ? { scope, startAt: pending.startAt, endAt: pending.endAt }
        : { scope: scope === "this" ? ("this" as const) : ("following" as const), cancelled: true as const };
    changeOccurrence.mutate(
      { id: occurrence.meetingId, on: occurrence.occursOn, change },
      {
        onSuccess: () => {
          setMeetingChange(null);
          if (pending.action === "cancel" && scope === "this")
            toast.show({
              message: `Cancelled ${occurrence.name} on ${dayLabel(occurrence.occursOn)}`,
              action: {
                label: "Undo",
                run: () =>
                  changeOccurrence.mutate({
                    id: occurrence.meetingId,
                    on: occurrence.occursOn,
                    change: { scope: "this", cancelled: false },
                  }),
              },
            });
        },
        onError: (failure) => setChangeError(errorMessage(failure)),
      },
    );
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
        todo.plannedOn === day &&
        !(placedByDay.get(day) ?? []).some((p) => p.item.kind === "block" && p.item.block.todoId === todo.id),
    );

  return (
    <div className={styles.page} data-fill>
      <PageHeader
        title="Planner"
        meta={`${formatDate(first)} – ${formatDate(last)}`}
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
            <strong>Proposed for {dayLabel(proposal.day)}:</strong> {proposal.note}
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
        <div className={styles.calendar} style={GRID_STYLE}>
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
                <span className={styles.weekday}>{weekdayName(day)}</span>
                <span className={styles.dayNumber}>{formatDayMonth(day)}</span>
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
            ref={body}
            className={styles.body}
            onScroll={retarget}
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
              {HOURS.map((hour) => (
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
                {day === now.day && (
                  <span
                    className={styles.nowLine}
                    style={{ top: (now.minutes / 60) * HOUR_PX }}
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
                          top: (timeToMinutes(b.start) / 60) * HOUR_PX,
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
                      top: (drag.target.startMin / 60) * HOUR_PX,
                      height: HOUR_PX - 2,
                    }}
                    aria-hidden="true"
                  >
                    {minutesToTime(drag.target.startMin)} {drag.todo.title}
                  </span>
                )}
                {(placedByDay.get(day) ?? []).map((placed) => {
                  const { item } = placed;
                  const shared = {
                    placed,
                    area: body,
                    dayIndex,
                    dayCount: days.length,
                  };
                  if (item.kind === "meeting") {
                    return (
                      <BlockCard
                        key={`${item.key}-${day}`}
                        {...shared}
                        title={item.occurrence.name}
                        meeting
                        onOpen={() => setOpenMeeting(item.occurrence)}
                        // A meeting date asks which dates the move is for; Cancel puts it back.
                        onDrop={(deltaMin, dayOffset, mode) => {
                          setChangeError(null);
                          setMeetingChange({
                            action: "move",
                            occurrence: item.occurrence,
                            ...movedSpan(item, deltaMin, dayOffset, mode, timeZone),
                          });
                        }}
                      />
                    );
                  }
                  const { block } = item;
                  return (
                    <BlockCard
                      key={`${item.key}-${day}`}
                      {...shared}
                      title={blockTitle(block)}
                      color={block.project?.color}
                      done={block.todo?.status === "done"}
                      onOpen={() => setDraft(draftOf(block))}
                      onDrop={(deltaMin, dayOffset, mode) =>
                        update.mutate(
                          { id: block.id, patch: movedSpan(block, deltaMin, dayOffset, mode, timeZone) },
                          {
                            onError: (failure) =>
                              toast.show({ tone: "error", message: errorMessage(failure) }),
                          },
                        )
                      }
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        <aside className={styles.side} aria-label="To plan">
          <h2 className={styles.sideTitle}>To plan</h2>
          <p className={`${styles.sideNote} ${styles.sideHint}`}>Next up without time this week.</p>
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
      <OccurrenceDialog
        occurrence={openMeeting}
        onClose={() => setOpenMeeting(null)}
        onMove={(occurrence, span) => {
          setOpenMeeting(null);
          setChangeError(null);
          setMeetingChange({ action: "move", occurrence, ...span });
        }}
        onCancel={(occurrence) => {
          setOpenMeeting(null);
          setChangeError(null);
          setMeetingChange({ action: "cancel", occurrence });
        }}
      />
      <SeriesScopeDialog
        open={meetingChange !== null}
        title={
          meetingChange?.action === "cancel"
            ? `Cancel ${meetingChange.occurrence.name} on ${dayLabel(meetingChange.occurrence.occursOn)}`
            : `Move ${meetingChange?.occurrence.name ?? "the meeting"}`
        }
        options={
          meetingChange?.action === "move"
            ? meetingMoveScopes(
                meetings.data?.find((m) => m.id === meetingChange.occurrence.meetingId)?.segments ?? [],
                meetingChange.occurrence,
                meetingChange.startAt,
                timeZone,
              )
            : MEETING_CANCEL_SCOPES
        }
        confirmLabel={meetingChange?.action === "cancel" ? "Cancel dates" : "Move"}
        danger={meetingChange?.action === "cancel"}
        busy={changeOccurrence.isPending || deleteMeeting.isPending}
        error={changeError}
        onPick={(scope) => meetingChange && applyMeetingChange(meetingChange, scope)}
        onCancel={() => setMeetingChange(null)}
      />
    </div>
  );
}

interface Drag {
  mode: "move" | "resize";
  /** Where the pointer went down, and the grid's scroll position then. */
  x: number;
  y: number;
  scrollTop: number;
  /** Where the pointer is now. */
  atX: number;
  atY: number;
  /** Width of a day column, for moving across days (0: it stays on its day). */
  colWidth: number;
  /** The day offsets within the shown week. */
  minOffset: number;
  maxOffset: number;
  moved: boolean;
  deltaMin: number;
  dayOffset: number;
}

/**
 * The drag with the pointer at (atX, atY) and the grid scrolled to scrollTop: scrolling the grid under
 * a held block moves it as far as moving the pointer would.
 */
function dragTo(drag: Drag, atX: number, atY: number, scrollTop: number): Drag {
  const dx = atX - drag.x;
  const dy = atY - drag.y + scrollTop - drag.scrollTop;
  const offset = drag.mode === "move" && drag.colWidth > 0 ? Math.round(dx / drag.colWidth) : 0;
  return {
    ...drag,
    atX,
    atY,
    moved: drag.moved || Math.abs(dx) > 4 || Math.abs(dy) > 4,
    deltaMin: snap((dy / HOUR_PX) * 60),
    dayOffset: Math.max(drag.minOffset, Math.min(drag.maxOffset, offset)),
  };
}

/**
 * One block. With a mouse it can be dragged: the body moves it (also to another day), the bottom edge
 * resizes it, both in 15 minute steps; a click without moving opens it. On touch screens a long press
 * picks it up (move, or resize near the bottom edge) and a tap opens it. Near the grid's top or bottom
 * edge a held block scrolls the grid, so it reaches every hour of the day.
 */
function BlockCard({
  placed,
  title,
  color,
  done = false,
  meeting = false,
  area,
  dayIndex,
  dayCount,
  onOpen,
  onDrop,
}: {
  placed: Placed;
  title: string;
  /** The project's colour; amber without one. */
  color?: string | undefined;
  done?: boolean;
  /** A meeting date: its own look, and a drop asks which dates it is for. */
  meeting?: boolean;
  /** The grid's scroll area. */
  area: RefObject<HTMLDivElement | null>;
  dayIndex: number;
  dayCount: number;
  onOpen: () => void;
  onDrop: (deltaMin: number, dayOffset: number, mode: "move" | "resize") => void;
}) {
  const { item } = placed;
  // The drag lives in a ref too, for the native touch and scroll listeners.
  const current = useRef<Drag | null>(null);
  const [drag, setDragState] = useState<Drag | null>(null);
  const setDrag = useCallback((next: Drag | null) => {
    current.current = next;
    setDragState(next);
  }, []);
  const baseTop = (placed.startMin / 60) * HOUR_PX;
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
      scrollTop: area.current?.scrollTop ?? 0,
      atX: event.clientX,
      atY: event.clientY,
      colWidth: column,
      minOffset: -dayIndex,
      maxOffset: dayCount - 1 - dayIndex,
      moved: false,
      deltaMin: 0,
      dayOffset: 0,
    });
  };
  // Touch drags run on the native touch listeners below.
  const move = (event: PointerEvent<HTMLElement>) => {
    const held = current.current;
    if (!held || event.pointerType !== "mouse") return;
    setDrag(dragTo(held, event.clientX, event.clientY, area.current?.scrollTop ?? held.scrollTop));
  };
  const end = (event: PointerEvent<HTMLElement>) => {
    const held = current.current;
    if (!held || event.pointerType !== "mouse") return;
    setDrag(null);
    if (!held.moved) {
      if (held.mode === "move") onOpen();
      return;
    }
    if (held.deltaMin !== 0 || held.dayOffset !== 0) onDrop(held.deltaMin, held.dayOffset, held.mode);
  };

  // A held block follows the grid when it scrolls (by the edge or the mouse wheel).
  const holding = drag !== null;
  useEffect(() => {
    const el = area.current;
    if (!holding || !el) return undefined;
    const follow = () => {
      const held = current.current;
      if (held) setDrag(dragTo(held, held.atX, held.atY, el.scrollTop));
    };
    el.addEventListener("scroll", follow, { passive: true });
    return () => el.removeEventListener("scroll", follow);
  }, [holding, area, setDrag]);
  useEdgeScroll(area, drag?.moved ? { x: drag.atX, y: drag.atY } : null);

  // Touch: a long press picks the block up (near the bottom edge of a tall one: resizes it), then it
  // follows the finger in 15 minute steps; a quick swipe still scrolls and a tap opens it. Native
  // listeners, because only a non-passive touchmove can stop the grid from scrolling once the drag has
  // started.
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
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch) return;
      origin = { x: touch.clientX, y: touch.clientY };
      // A short card (a 15 minute meeting) has no room for both: a long press there moves it.
      const rect = el.getBoundingClientRect();
      const mode = rect.height >= 40 && touch.clientY > rect.bottom - 16 ? "resize" : "move";
      timer = window.setTimeout(() => {
        if (!origin) return;
        navigator.vibrate?.(10);
        setDrag({
          mode,
          x: origin.x,
          y: origin.y,
          scrollTop: area.current?.scrollTop ?? 0,
          atX: origin.x,
          atY: origin.y,
          colWidth: 0,
          minOffset: 0,
          maxOffset: 0,
          moved: true,
          deltaMin: 0,
          dayOffset: 0,
        });
      }, 350);
    };
    const onMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch || !origin) return;
      const held = current.current;
      if (!held) {
        if (Math.hypot(touch.clientX - origin.x, touch.clientY - origin.y) > 8) {
          window.clearTimeout(timer);
          origin = null;
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setDrag(dragTo(held, touch.clientX, touch.clientY, area.current?.scrollTop ?? held.scrollTop));
    };
    const onEnd = (event: TouchEvent) => {
      window.clearTimeout(timer);
      origin = null;
      const dropped = current.current;
      if (!dropped) return;
      // Neither a click (opening the block) nor the day swipe of the calendar.
      event.preventDefault();
      event.stopPropagation();
      setDrag(null);
      if (dropped.deltaMin !== 0) dropRef.current(dropped.deltaMin, 0, dropped.mode);
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
  }, [area, setDrag]);

  const style = {
    top,
    height,
    transform: drag?.dayOffset ? `translateX(${drag.dayOffset * drag.colWidth}px)` : undefined,
    // Overlaps cascade like a calendar: each later lane is indented and drawn on top, so every block
    // keeps most of the column's width.
    left: `calc(${placed.lane * Math.min(28, 60 / placed.lanes)}% + 2px)`,
    right: "2px",
    zIndex: 1 + placed.lane,
    "--block": color ?? (meeting ? "var(--meeting)" : "var(--amber)"),
  } as CSSProperties;
  const time = spanText(item, timeZone);
  return (
    <button
      ref={ref}
      type="button"
      className={styles.block}
      style={style}
      data-done={done || undefined}
      data-meeting={meeting || undefined}
      data-short={height < 40 || undefined}
      data-dragging={drag?.moved || undefined}
      onPointerDown={(event) => start(event, "move")}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={(event) => event.pointerType === "mouse" && setDrag(null)}
      // Keyboard and touch: a click opens the block (a mouse click is handled on pointer up).
      onClick={(event) => {
        if (event.detail === 0 || !matchesMouse(event)) onOpen();
      }}
      title={`${title}, ${time}${meeting ? ", meeting" : ""}`}
    >
      <span className={styles.blockTitle}>
        {meeting && <MeetingMark />}
        {title}
      </span>
      <span className={styles.blockTime}>{time}</span>
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

/** The small speech bubbles that mark a meeting card. */
function MeetingMark() {
  return (
    <svg className={styles.meetingMark} width="11" height="11" viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M3 4h10v7H8l-3 2.5V11H3zM13 7.5h4v7h-2V17l-3-2.5H9V11"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Whether a click came from a mouse (pointer events already handled it). */
const matchesMouse = (event: MouseEvent<HTMLElement>): boolean =>
  (event.nativeEvent as globalThis.PointerEvent).pointerType === "mouse";
