import {
  addDays,
  localTimeToInstant,
  startOfLocalDay,
  type TimeBlock,
  toLocalDate,
  toLocalTime,
} from "@organizer/shared";

/** The planner's visible hours: 7:00 to 22:00, widened to fit blocks outside. */
export const DEFAULT_FIRST_HOUR = 7;
export const DEFAULT_LAST_HOUR = 22;
export const SNAP_MINUTES = 15;

export interface PlacedBlock {
  block: TimeBlock;
  /** Minutes from the day's local midnight, clamped to the day. */
  startMin: number;
  endMin: number;
  lane: number;
  lanes: number;
  /** The block goes on before this day / after it. */
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/** The dates of `count` days from `first`. */
export const dayList = (first: string, count: number): string[] =>
  Array.from({ length: count }, (_, i) => addDays(first, i));

/**
 * The blocks of one local day, with their minutes in that day and side by side lanes for overlaps
 * (each cluster of overlapping blocks shares its lane count).
 */
export function placeBlocks(blocks: readonly TimeBlock[], day: string, timeZone: string): PlacedBlock[] {
  const dayStart = startOfLocalDay(day, timeZone).getTime();
  const dayEnd = startOfLocalDay(addDays(day, 1), timeZone).getTime();
  const inDay = blocks
    .map((block) => ({ block, start: Date.parse(block.startAt), end: Date.parse(block.endAt) }))
    .filter((b) => b.start < dayEnd && b.end > dayStart)
    .toSorted((a, b) => a.start - b.start || b.end - a.end || a.block.id - b.block.id);

  const placed: PlacedBlock[] = [];
  let cluster: PlacedBlock[] = [];
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
    const entry: PlacedBlock = {
      block: b.block,
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

/** First and last visible hour: the defaults, widened to every placed block. */
export function visibleHours(placed: readonly PlacedBlock[]): { first: number; last: number } {
  let first = DEFAULT_FIRST_HOUR;
  let last = DEFAULT_LAST_HOUR;
  for (const p of placed) {
    first = Math.min(first, Math.floor(p.startMin / 60));
    last = Math.max(last, Math.ceil(p.endMin / 60));
  }
  return { first: Math.max(0, first), last: Math.min(24, last) };
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
