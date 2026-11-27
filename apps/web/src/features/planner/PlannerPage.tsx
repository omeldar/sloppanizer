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
import { useCurrentAccount } from "../../app/account.tsx";
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
import {
  dayLabel,
  formatDate,
  formatDayMonth,
  formatHour,
  formatTime,
  timeZone,
  today,
  weekdayName,
} from "../../lib/format.ts";
import { errorMessage } from "../../lib/api.ts";
import { useAssignedToMe, useSharedTodos } from "../../lib/spaces.ts";
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
import { type DragTodo, dragKey, useTodoDrag } from "./useTodoDrag.ts";
import { BlockCard } from "./BlockCard.tsx";
import { planDay, useAiSettings } from "../../lib/ai.ts";
import type { CheckedBlock } from "@organizer/shared";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import { useKeys } from "../../keyboard/KeyboardProvider.tsx";
import { BlockDialog, type BlockDraft, draftOf, plannedSharedText } from "./BlockDialog.tsx";
import styles from "./Planner.module.css";
import {
  blockColor,
  blockItem,
  blockSource,
  blockSpan,
  blockTitle,
  HOUR_PX,
  MEETING_CANCEL_SCOPES,
  ONE_TIME_CANCEL_SCOPES,
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
  // Todos of your shared projects assigned to you, planned for a day of this week (your own tab only).
  const sharedPlanned = useSharedTodos({
    status: "all",
    plannedFrom: first,
    plannedTo: last,
    sort: "priority",
    order: "desc",
    limit: 200,
  });
  const next = useNext({ mode: "smart" });
  const assigned = useAssignedToMe();
  const account = useCurrentAccount();
  const me = account?.username ?? null;
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

  const planTodo = (todo: DragTodo, day = selected) => {
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
      // A shared project's todo gets its time in that project (and goes to you if nobody is on it).
      if (todo.space)
        create.mutate(
          { todoId: todo.id, ...span, space: todo.space.id },
          {
            onSuccess: (block) => toast.show({ message: plannedSharedText(todo.title, block.assignee, me) }),
            onError: toastError,
          },
        );
      else if (canRepeatPlan(knownTodos.get(todo.id)?.recurrence ?? null) && !plannedRepeats.has(todo.id))
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

  /**
   * A meeting date change: asks which dates it is for. A one-time meeting has only one date, so a move
   * applies right away (the card stays where it was dropped meanwhile); removing it asks before deleting.
   */
  const startMeetingChange = (pending: MeetingChange) => {
    setChangeError(null);
    setMeetingChange(pending);
    if (pending.occurrence.oneTime && pending.action === "move") applyMeetingChange(pending, "this");
  };
  const askingScope =
    meetingChange !== null && !(meetingChange.occurrence.oneTime && meetingChange.action === "move");

  const applyMeetingChange = (pending: MeetingChange, scope: SeriesScope) => {
    const { occurrence } = pending;
    const failed = (failure: unknown) => {
      if (occurrence.oneTime && pending.action === "move") {
        setMeetingChange(null);
        toast.show({ message: errorMessage(failure) });
      } else setChangeError(errorMessage(failure));
    };
    if (pending.action === "cancel" && scope === "all") {
      deleteMeeting.mutate(occurrence.meetingId, {
        onSuccess: () => {
          setMeetingChange(null);
          toast.show({ message: `Deleted ${occurrence.name}` });
        },
        onError: failed,
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
        onError: failed,
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
  /** Todos with time this week, by dragKey (a shared project's todo is told apart by its project). */
  const planned = new Set([
    ...(blocks.data ?? []).flatMap((b) =>
      b.todoId === null ? [] : [dragKey({ id: b.todoId, space: b.space })],
    ),
    ...[...plannedRepeats].map(String),
  ]);
  /** Next up without time this week: your own and the todos assigned to you in shared projects, by score. */
  const toPlan: (DragTodo & { score: number })[] = [
    ...(next.data?.items ?? []).map((item) => ({
      id: item.todo.id,
      title: item.todo.title,
      score: item.score,
    })),
    ...assigned.items.map(({ space, item }) => ({
      id: item.todo.id,
      title: item.todo.title,
      score: item.score,
      space: { id: space.id, name: space.name, color: space.color },
    })),
  ]
    .filter((todo) => !planned.has(dragKey(todo)))
    .toSorted((a, b) => b.score - a.score)
    .slice(0, 8);
  /** Todos planned for a day of this week that have no time that day yet (your shared ones too). */
  const dayTodos = (day: string): (DragTodo & { key: string })[] =>
    [
      ...(plannedTodos.data?.items ?? []).map((todo) => ({ todo, space: null })),
      ...sharedPlanned.items.map(({ space, todo }) => ({
        todo,
        space: { id: space.id, name: space.name, color: space.color },
      })),
    ]
      .filter(
        ({ todo, space }) =>
          todo.plannedOn === day &&
          !(placedByDay.get(day) ?? []).some(
            (p) =>
              (p.item.kind === "block" &&
                p.item.block.todoId === todo.id &&
                (p.item.block.space?.id ?? null) === (space?.id ?? null)) ||
              (space === null && p.item.kind === "repeat" && p.item.occurrence.todo.id === todo.id),
          ),
      )
      .map(({ todo, space }) => ({
        id: todo.id,
        title: todo.title,
        space,
        key: dragKey({ id: todo.id, space }),
      }));
  const dragging = drag?.active ? dragKey(drag.todo) : null;

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
                    {formatTime(b.start)}–{formatTime(b.end)}
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
                  {dayTodos(day).map(({ key, ...todo }) => (
                    <button
                      key={key}
                      type="button"
                      className={styles.dayTodo}
                      title={`Drag into the day, or click to plan time for ${todo.title}${todo.space ? ` (${todo.space.name})` : ""}`}
                      data-dragging={dragging === key || undefined}
                      {...bind(todo, { touch: true })}
                    >
                      {todo.title}
                      {todo.space && <SpaceMark space={todo.space} />}
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
                  {formatHour(hour)}
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
                          {formatTime(b.start)}–{formatTime(b.end)}
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
                    {formatTime(minutesToTime(drag.target.startMin))} {drag.todo.title}
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
                        onDrop={(deltaMin, dayOffset, mode) =>
                          startMeetingChange({
                            action: "move",
                            occurrence: item.occurrence,
                            ...movedSpan(item, deltaMin, dayOffset, mode, timeZone),
                          })
                        }
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
                      source={blockSource(block, me)}
                      color={blockColor(block)}
                      done={block.todo?.status === "done"}
                      onOpen={() => setDraft(draftOf(block))}
                      onDrop={(deltaMin, dayOffset, mode) =>
                        update.mutate(
                          {
                            id: block.id,
                            patch: movedSpan(block, deltaMin, dayOffset, mode, timeZone),
                            space: block.space?.id,
                          },
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
          <p className={`${styles.sideNote} ${styles.sideHint}`}>
            Next up without time this week, and what is assigned to you in shared projects.
          </p>
          {toPlan.length === 0 && (
            <p className={styles.sideNote}>Everything near the top has time planned.</p>
          )}
          <ul className={styles.toPlan}>
            {toPlan.map(({ score: _score, ...todo }) => (
              <li key={dragKey(todo)}>
                <button
                  type="button"
                  className={styles.toPlanItem}
                  title="Drag onto the calendar, or click to plan time"
                  data-dragging={dragging === dragKey(todo) || undefined}
                  {...bind(todo)}
                >
                  <span className={styles.toPlanTitle}>
                    {todo.title}
                    {todo.space && <SpaceMark space={todo.space} />}
                  </span>
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
          startMeetingChange({ action: "move", occurrence, ...span });
        }}
        onCancel={(occurrence) => {
          setOpenMeeting(null);
          startMeetingChange({ action: "cancel", occurrence });
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
        open={askingScope}
        title={
          meetingChange?.action === "cancel"
            ? meetingChange.occurrence.oneTime
              ? `Delete ${meetingChange.occurrence.name} on ${dayLabel(meetingChange.occurrence.occursOn)}`
              : `Cancel ${meetingChange.occurrence.name} on ${dayLabel(meetingChange.occurrence.occursOn)}`
            : `Move ${meetingChange?.occurrence.name ?? "the meeting"}`
        }
        options={
          meetingChange?.action === "cancel" && meetingChange.occurrence.oneTime
            ? ONE_TIME_CANCEL_SCOPES
            : meetingChange?.action === "move"
              ? seriesMoveScopes(
                  meetings.data?.find((m) => m.id === meetingChange.occurrence.meetingId)?.segments ?? [],
                  meetingChange.occurrence,
                  meetingChange.startAt,
                  timeZone,
                )
              : MEETING_CANCEL_SCOPES
        }
        confirmLabel={
          meetingChange?.action === "cancel"
            ? meetingChange.occurrence.oneTime
              ? "Delete"
              : "Cancel dates"
            : "Move"
        }
        danger={meetingChange?.action === "cancel"}
        busy={changeOccurrence.isPending || deleteMeeting.isPending}
        error={changeError}
        onPick={(scope) => meetingChange && applyMeetingChange(meetingChange, scope)}
        onCancel={() => setMeetingChange(null)}
      />
    </div>
  );
}

/** The shared project a todo in the Day row or To plan comes from. */
function SpaceMark({ space }: { space: { name: string; color: string } }) {
  return (
    <span className={styles.fromSpace} style={{ "--swatch": space.color } as CSSProperties}>
      {space.name}
    </span>
  );
}
