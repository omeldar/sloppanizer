import {
  addDays,
  dayShift,
  localTimeToInstant,
  type MeetingOccurrence,
  type Series,
  shiftRule,
  startOfLocalDay,
  type TimeBlock,
  toLocalDate,
  toLocalTime,
} from "@organizer/shared";
import type { ScopeOption } from "../../components/SeriesScopeDialog.tsx";
import { formatDayMonth } from "../../lib/format.ts";

export const SNAP_MINUTES = 15;
/** The planner shows the whole day; it opens at this hour unless it shows today. */
export const DAY_START_HOUR = 7;

/** Something with a time in the planner: a key that stays the same across renders, a start and an end. */
export interface Span {
  key: string;
  startAt: string;
  endAt: string;
}

/** What the planner shows: time blocks, and the dates of meetings (repeating, changed per date). */
export type PlannerItem = Span &
  ({ kind: "block"; block: TimeBlock } | { kind: "meeting"; occurrence: MeetingOccurrence });

export const blockItem = (block: TimeBlock): PlannerItem => ({
  kind: "block",
  block,
  key: `block-${block.id}`,
  startAt: block.startAt,
  endAt: block.endAt,
});

/** A meeting date; `span` shows it somewhere else while a move waits for its answer. */
export const meetingItem = (
  occurrence: MeetingOccurrence,
  span: Pick<Span, "startAt" | "endAt"> = occurrence,
): PlannerItem => ({
  kind: "meeting",
  occurrence,
  key: `meeting-${occurrence.meetingId}-${occurrence.occursOn}`,
  startAt: span.startAt,
  endAt: span.endAt,
});

export interface Placed<T extends Span = PlannerItem> {
  item: T;
  /** Minutes from the day's local midnight, clamped to the day. */
  startMin: number;
  endMin: number;
  lane: number;
  lanes: number;
  /** The item goes on before this day / after it. */
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/** The dates of `count` days from `first`. */
export const dayList = (first: string, count: number): string[] =>
  Array.from({ length: count }, (_, i) => addDays(first, i));

const byKey = (a: Span, b: Span): number => a.key.localeCompare(b.key, "en", { numeric: true });

/**
 * The items of one local day, with their minutes in that day and side by side lanes for overlaps
 * (each cluster of overlapping items shares its lane count). Blocks and meetings share the lanes.
 */
export function placeItems<T extends Span>(items: readonly T[], day: string, timeZone: string): Placed<T>[] {
  const dayStart = startOfLocalDay(day, timeZone).getTime();
  const dayEnd = startOfLocalDay(addDays(day, 1), timeZone).getTime();
  const inDay = items
    .map((item) => ({ item, start: Date.parse(item.startAt), end: Date.parse(item.endAt) }))
    .filter((b) => b.start < dayEnd && b.end > dayStart)
    .toSorted((a, b) => a.start - b.start || b.end - a.end || byKey(a.item, b.item));

  const placed: Placed<T>[] = [];
  let cluster: Placed<T>[] = [];
  let clusterEnd = -Infinity;
  const laneEnds: number[] = [];
  const closeCluster = () => {
    const lanes = Math.max(1, ...cluster.map((p) => p.lane + 1));
    for (const p of cluster) p.lanes = lanes;
    cluster = [];
    laneEnds.length = 0;
  };
  for (const b of inDay) {
    if (b.start >= clusterEnd && cluster.length > 0) closeCluster();
    let lane = laneEnds.findIndex((end) => end <= b.start);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = b.end;
    const entry: Placed<T> = {
      item: b.item,
      startMin: Math.max(0, (b.start - dayStart) / 60_000),
      endMin: Math.min((dayEnd - dayStart) / 60_000, (b.end - dayStart) / 60_000),
      lane,
      lanes: 1,
      continuesBefore: b.start < dayStart,
      continuesAfter: b.end > dayEnd,
    };
    cluster.push(entry);
    placed.push(entry);
    clusterEnd = Math.max(clusterEnd, b.end);
  }
  closeCluster();
  return placed;
}

/**
 * Where the planner's grid opens, in minutes after midnight: an hour before now on the week with today
 * (so the next hours are in view), the start of a normal day on other weeks.
 */
export const scrollStartMinutes = (showsToday: boolean, nowMinutes: number): number =>
  showsToday ? Math.max(0, nowMinutes - 60) : DAY_START_HOUR * 60;

/** Pixels per animation frame to scroll an area while a drag nears its top or bottom edge (negative: up). */
export function edgeScrollStep(
  point: { x: number; y: number },
  area: { top: number; bottom: number; left: number; right: number },
  edge = 48,
  fastest = 16,
): number {
  if (point.x < area.left || point.x > area.right) return 0;
  const speed = (depth: number) => Math.ceil(fastest * Math.min(1, depth / edge));
  if (point.y < area.top + edge) return -speed(area.top + edge - point.y);
  if (point.y > area.bottom - edge) return speed(point.y - (area.bottom - edge));
  return 0;
}

/** Rounds minutes to the planner's 15 minute grid. */
export const snap = (minutes: number): number => Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES;

/** "HH:mm" for minutes after midnight (24:00 stays 24:00 for an end). */
export function minutesToTime(minutes: number): string {
  const m = Math.max(0, Math.min(24 * 60, Math.round(minutes)));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function timeToMinutes(time: string): number {
  const [h = "0", m = "0"] = time.split(":");
  return Number(h) * 60 + Number(m);
}

/** Minutes from start to end ("HH:mm"); an end at or before the start is the next day, like blockSpan. */
export function lengthMinutes(start: string, end: string): number {
  const day = 24 * 60;
  return (timeToMinutes(end) - timeToMinutes(start) + day) % day || day;
}

/** The instants of a block on a local day from start to end ("HH:mm"); an end at or before the start is the next day. */
export function blockSpan(
  day: string,
  start: string,
  end: string,
  timeZone: string,
): { startAt: string; endAt: string } {
  const startAt = localTimeToInstant(day, start, timeZone);
  let endAt =
    end === "24:00" ? startOfLocalDay(addDays(day, 1), timeZone) : localTimeToInstant(day, end, timeZone);
  if (endAt <= startAt)
    endAt = localTimeToInstant(addDays(day, 1), end === "24:00" ? "00:00" : end, timeZone);
  return { startAt: startAt.toISOString(), endAt: endAt.toISOString() };
}

/** "09:00–10:30" in local time. */
export const spanText = (block: Pick<TimeBlock, "startAt" | "endAt">, timeZone: string): string =>
  `${toLocalTime(block.startAt, timeZone)}–${toLocalTime(block.endAt, timeZone)}`;

/** What a block is for: its todo's title, else its own title. */
export const blockTitle = (block: TimeBlock): string => block.todo?.title ?? block.title;

/** Why only this date can move: the repeat has no rule for its dates moved by that many days. */
export const ONLY_THIS_DAY = "Only this date can move to another day for this repeat.";

/**
 * The choices for moving a meeting date to a new start: this one always; this and following and all
 * only when every date of the repeat can move by the same days. "All" changes only the part of a split
 * repeat that holds the date, so it says from when.
 */
export function meetingMoveScopes(
  segments: readonly Series[],
  occurrence: Pick<MeetingOccurrence, "seriesId" | "occursOn">,
  startAt: string,
  timeZone: string,
): ScopeOption[] {
  const segment = segments.find((s) => s.id === occurrence.seriesId);
  const delta = dayShift(occurrence.occursOn, startAt, timeZone);
  const off = !segment || (delta !== 0 && shiftRule(segment.rule, delta) === null) ? ONLY_THIS_DAY : null;
  const split = segments.length > 1 && segment !== undefined;
  return [
    { scope: "this" },
    { scope: "following", off, hint: `From ${formatDayMonth(occurrence.occursOn)} on` },
    {
      scope: "all",
      off,
      hint: split
        ? `Every date from ${formatDayMonth(segment.startsOn)} on, this part of the repeat`
        : "Every date",
    },
  ];
}

/** The choices for cancelling a meeting date: all of them deletes the meeting. */
export const MEETING_CANCEL_SCOPES: readonly ScopeOption[] = [
  { scope: "this" },
  { scope: "following", hint: "The repeat ends the day before" },
  { scope: "all", hint: "Deletes the meeting, with what you marked as said" },
];

/** The next full quarter hour after now, as "HH:mm" (for a new block's start). */
export function nextQuarter(now: Date, timeZone: string): string {
  const [h = 0, m = 0] = toLocalTime(now, timeZone).split(":").map(Number);
  return minutesToTime(Math.min(23 * 60 + 45, Math.ceil((h * 60 + m + 1) / SNAP_MINUTES) * SNAP_MINUTES));
}

/**
 * Where a dragged block lands: "move" shifts it by minutes and days and keeps its length; "resize"
 * moves only its end (never shorter than 15 minutes).
 */
export function movedSpan(
  block: Pick<TimeBlock, "startAt" | "endAt">,
  deltaMin: number,
  dayOffset: number,
  mode: "move" | "resize",
  timeZone: string,
): { startAt: string; endAt: string } {
  const start = Date.parse(block.startAt);
  const end = Date.parse(block.endAt);
  if (mode === "resize") {
    return {
      startAt: block.startAt,
      endAt: new Date(Math.max(start + SNAP_MINUTES * 60_000, end + deltaMin * 60_000)).toISOString(),
    };
  }
  const day = addDays(toLocalDate(block.startAt, timeZone), dayOffset);
  const startMin = timeToMinutes(toLocalTime(block.startAt, timeZone)) + deltaMin;
  const clamped = Math.max(0, Math.min(24 * 60 - SNAP_MINUTES, startMin));
  const startAt = localTimeToInstant(day, minutesToTime(clamped), timeZone);
  return { startAt: startAt.toISOString(), endAt: new Date(startAt.getTime() + (end - start)).toISOString() };
}
