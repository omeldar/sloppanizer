import type { CSSProperties, MouseEvent, RefObject } from "react";
import { timeZone } from "../../lib/format.ts";
import styles from "./Planner.module.css";
import { HOUR_PX, type Placed, spanText } from "./planner.ts";
import { type DropHandler, useBlockDrag } from "./useBlockDrag.ts";

/**
 * One item in the planner grid: a time block, a planned date of a repeating todo or a meeting date. It
 * can be dragged to move (also to another day) or resized (useBlockDrag); a click or tap opens it.
 */
export function BlockCard({
  placed,
  title,
  color,
  done = false,
  meeting = false,
  repeats = false,
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
  /** A date of a repeating todo's planned time: marked, and a drop asks which dates it is for. */
  repeats?: boolean;
  /** The grid's scroll area. */
  area: RefObject<HTMLDivElement | null>;
  dayIndex: number;
  dayCount: number;
  onOpen: () => void;
  onDrop: DropHandler;
}) {
  const { item } = placed;
  const { drag, ref, start, move, end, cancel } = useBlockDrag({
    area,
    hourPx: HOUR_PX,
    dayIndex,
    dayCount,
    onOpen,
    onDrop,
  });
  const baseTop = (placed.startMin / 60) * HOUR_PX;
  const baseHeight = Math.max(22, ((placed.endMin - placed.startMin) / 60) * HOUR_PX - 2);
  const deltaPx = drag ? (drag.deltaMin / 60) * HOUR_PX : 0;
  const top = drag?.mode === "move" ? baseTop + deltaPx : baseTop;
  const height = drag?.mode === "resize" ? Math.max(HOUR_PX / 4 - 2, baseHeight + deltaPx) : baseHeight;

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
  const kind = meeting ? ", meeting" : repeats ? ", repeats" : "";
  return (
    <button
      ref={ref}
      type="button"
      className={styles.block}
      style={style}
      data-done={done || undefined}
      data-meeting={meeting || undefined}
      data-repeats={repeats || undefined}
      data-short={height < 40 || undefined}
      data-dragging={drag?.moved || undefined}
      onPointerDown={(event) => start(event, "move")}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={cancel}
      // Keyboard and touch: a click opens the block (a mouse click is handled on pointer up).
      onClick={(event) => {
        if (event.detail === 0 || !matchesMouse(event)) onOpen();
      }}
      title={`${title}, ${time}${kind}`}
    >
      <span className={styles.blockTitle}>
        {meeting && <MeetingMark />}
        {repeats && <RepeatMark />}
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

/** Two arrows in a circle: planned time that repeats with its todo. */
function RepeatMark() {
  return (
    <svg className={styles.meetingMark} width="11" height="11" viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M4 9a6 6 0 0 1 10.5-4M16 11a6 6 0 0 1-10.5 4M14.5 1.5V5H11M5.5 18.5V15H9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Whether a click came from a mouse (pointer events already handled it). */
const matchesMouse = (event: MouseEvent<HTMLElement>): boolean =>
  (event.nativeEvent as globalThis.PointerEvent).pointerType === "mouse";
