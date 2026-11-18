import {
  addDays,
  type BlockOccurrence,
  canRepeatPlan,
  type MeetingOccurrence,
  type SeriesScope,
  type Todo,
  toLocalTime,
  weekDays,
} from "@organizer/shared";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import {
  type CSSProperties,
  type MouseEvent,
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
import { PlannedDateDialog } from "./PlannedDateDialog.tsx";
import {
  useChangeRepeatDate,
  useCreateRepeatPlan,
  useDeleteRepeatPlan,
  useRepeatOccurrences,
  useRepeatPlan,
} from "../../lib/plans.ts";
import { useEdgeScroll } from "./useEdgeScroll.ts";
import { useTodoDrag } from "./useTodoDrag.ts";
import { BlockCard } from "./BlockCard.tsx";
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
  HOUR_PX,
  MEETING_CANCEL_SCOPES,
  REPEAT_CANCEL_SCOPES,
  repeatItem,
  meetingItem,
  seriesMoveScopes,
  minutesToTime,
  movedSpan,
  nextQuarter,
  placeItems,
  scrollStartMinutes,
  snap,
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
/** A change of a repeating todo's planned date, waiting for "this one, following or all". */
type RepeatChange =
  | { action: "move"; occurrence: BlockOccurrence; startAt: string; endAt: string }
  | { action: "cancel"; occurrence: BlockOccurrence };

/** The grid always shows the whole day; it scrolls inside itself. */
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

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
  const repeats = useRepeatOccurrences(first, last);
  const [openRepeat, setOpenRepeat] = useState<BlockOccurrence | null>(null);
  const [repeatChange, setRepeatChange] = useState<RepeatChange | null>(null);
  const [repeatError, setRepeatError] = useState<string | null>(null);
  const changeRepeat = useChangeRepeatDate();
  const deleteRepeat = useDeleteRepeatPlan();
  const createRepeat = useCreateRepeatPlan();
  const changingPlan = useRepeatPlan(repeatChange?.occurrence.ownerTodoId ?? 0, repeatChange !== null);
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
      ...(repeats.data ?? [])
        .filter((o) => o.status !== "cancelled")
        .map((o) =>
          repeatChange?.action === "move" &&
          repeatChange.occurrence.seriesId === o.seriesId &&
          repeatChange.occurrence.occursOn === o.occursOn
            ? repeatItem(o, repeatChange)
            : repeatItem(o),
        ),
    ];
    return new Map(days.map((day) => [day, placeItems(items, day, timeZone)]));
  }, [blocks.data, occurrences.data, meetingChange, repeats.data, repeatChange, days]);
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
  const toastError = (failure: unknown) => toast.show({ tone: "error", message: errorMessage(failure) });
  const { drag, bind, retarget } = useTodoDrag({
    hourPx: HOUR_PX,
    onClick: (todo) => planTodo(todo),
    // A dropped todo gets an hour from where it landed; move or resize the block after. A todo that
    // repeats on a schedule gets time on every date of its repeat, unless it has planned time already.
    onDrop: (todo, day, startMin) => {
      const span = blockSpan(
        day,
        minutesToTime(startMin),
        minutesToTime(Math.min(24 * 60, startMin + 60)),
        timeZone,
      );
      if (canRepeatPlan(knownTodos.get(todo.id)?.recurrence ?? null) && !plannedRepeats.has(todo.id))
        createRepeat.mutate(
          { todoId: todo.id, span },
          {
            onSuccess: (plan) => toast.show({ message: `Planned ${todo.title}: ${plan.schedule.text}` }),
            onError: toastError,
          },
        );
      else create.mutate({ todoId: todo.id, ...span }, { onError: toastError });
    },
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

  const applyRepeatChange = (pending: RepeatChange, scope: SeriesScope) => {
    const { occurrence } = pending;
    const todoId = occurrence.ownerTodoId;
    const settled = {
      onError: (failure: unknown) => setRepeatError(errorMessage(failure)),
    };
    if (pending.action === "cancel" && scope === "all") {
      deleteRepeat.mutate(todoId, {
        ...settled,
        onSuccess: () => {
          setRepeatChange(null);
          toast.show({ message: `Removed the planned time of ${occurrence.todo.title}` });
        },
      });
      return;
    }
    const change =
      pending.action === "move"
        ? { scope, startAt: pending.startAt, endAt: pending.endAt }
        : { scope: scope === "this" ? ("this" as const) : ("following" as const), cancelled: true as const };
    changeRepeat.mutate(
      { todoId, on: occurrence.occursOn, change },
      {
        ...settled,
        onSuccess: () => {
          setRepeatChange(null);
          if (pending.action === "cancel" && scope === "this")
            toast.show({
              message: `Removed ${occurrence.todo.title} on ${dayLabel(occurrence.occursOn)}`,
              action: {
                label: "Undo",
                run: () =>
                  changeRepeat.mutate({
                    todoId,
                    on: occurrence.occursOn,
                    change: { scope: "this", cancelled: false },
                  }),
              },
            });
        },
      },
    );
  };

  /** Todos the page knows in full (for their repeat), and those whose repeat has planned time. */
  const knownTodos = new Map<number, Todo>(
    [...(next.data?.items ?? []).map((item) => item.todo), ...(plannedTodos.data?.items ?? [])].map((t) => [
      t.id,
      t,
    ]),
  );
  const plannedRepeats = new Set((repeats.data ?? []).flatMap((o) => [o.todo.id, o.ownerTodoId]));
  const planned = new Set([
    ...(blocks.data ?? []).flatMap((b) => (b.todoId === null ? [] : [b.todoId])),
    ...plannedRepeats,
  ]);
  const toPlan = (next.data?.items ?? [])
    .map((item) => item.todo)
    .filter((todo) => !planned.has(todo.id))
    .slice(0, 8);
  /** Todos planned for a day of this week that have no time that day yet. */
  const dayTodos = (day: string) =>
    (plannedTodos.data?.items ?? []).filter(
      (todo) =>
        todo.plannedOn === day &&
        !(placedByDay.get(day) ?? []).some(
          (p) =>
            (p.item.kind === "block" && p.item.block.todoId === todo.id) ||
            (p.item.kind === "repeat" && p.item.occurrence.todo.id === todo.id),
        ),
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
                  if (item.kind === "repeat") {
                    const { occurrence } = item;
                    return (
                      <BlockCard
                        key={`${item.key}-${day}`}
                        {...shared}
                        title={occurrence.todo.title}
                        color={occurrence.project?.color}
                        done={occurrence.todo.status === "done"}
                        repeats
                        onOpen={() => setOpenRepeat(occurrence)}
                        // A planned date of a repeat asks which dates the move is for; Cancel puts it back.
                        onDrop={(deltaMin, dayOffset, mode) => {
                          setRepeatError(null);
                          setRepeatChange({
                            action: "move",
                            occurrence,
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
      <PlannedDateDialog
        occurrence={openRepeat}
        onClose={() => setOpenRepeat(null)}
        onMove={(occurrence, span) => {
          setOpenRepeat(null);
          setRepeatError(null);
          setRepeatChange({ action: "move", occurrence, ...span });
        }}
        onCancel={(occurrence) => {
          setOpenRepeat(null);
          setRepeatError(null);
          setRepeatChange({ action: "cancel", occurrence });
        }}
      />
      <SeriesScopeDialog
        open={repeatChange !== null}
        title={
          repeatChange?.action === "cancel"
            ? `Remove ${repeatChange.occurrence.todo.title} on ${dayLabel(repeatChange.occurrence.occursOn)}`
            : `Move ${repeatChange?.occurrence.todo.title ?? "the planned time"}`
        }
        options={
          repeatChange?.action === "move"
            ? seriesMoveScopes(
                changingPlan.data?.segments ?? [],
                repeatChange.occurrence,
                repeatChange.startAt,
                timeZone,
              )
            : REPEAT_CANCEL_SCOPES
        }
        confirmLabel={repeatChange?.action === "cancel" ? "Remove" : "Move"}
        danger={repeatChange?.action === "cancel"}
        busy={changeRepeat.isPending || deleteRepeat.isPending}
        error={repeatError}
        onPick={(scope) => repeatChange && applyRepeatChange(repeatChange, scope)}
        onCancel={() => setRepeatChange(null)}
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
            ? seriesMoveScopes(
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
