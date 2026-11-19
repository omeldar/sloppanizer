import { type PointerEvent, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { snap } from "./planner.ts";
import { useEdgeScroll } from "./useEdgeScroll.ts";

/** Where a held block is, while it is dragged. */
export interface BlockDrag {
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
export function dragTo(
  drag: BlockDrag,
  atX: number,
  atY: number,
  scrollTop: number,
  hourPx: number,
): BlockDrag {
  const dx = atX - drag.x;
  const dy = atY - drag.y + scrollTop - drag.scrollTop;
  const offset = drag.mode === "move" && drag.colWidth > 0 ? Math.round(dx / drag.colWidth) : 0;
  return {
    ...drag,
    atX,
    atY,
    moved: drag.moved || Math.abs(dx) > 4 || Math.abs(dy) > 4,
    deltaMin: snap((dy / hourPx) * 60),
    dayOffset: Math.max(drag.minOffset, Math.min(drag.maxOffset, offset)),
  };
}

export type DropHandler = (deltaMin: number, dayOffset: number, mode: BlockDrag["mode"]) => void;

/**
 * Dragging one block in the planner grid. With a mouse the body moves it (also to another day) and the
 * bottom edge resizes it, both in 15 minute steps; a click without moving opens it. On touch screens a
 * long press picks it up (move, or resize near the bottom edge of a tall card) and a tap opens it. Near
 * the grid's top or bottom edge a held block scrolls the grid, so it reaches every hour of the day.
 */
export function useBlockDrag({
  area,
  hourPx,
  dayIndex,
  dayCount,
  onOpen,
  onDrop,
}: {
  /** The grid's scroll area. */
  area: RefObject<HTMLDivElement | null>;
  hourPx: number;
  dayIndex: number;
  dayCount: number;
  onOpen: () => void;
  onDrop: DropHandler;
}) {
  // The drag lives in a ref too, for the native touch and scroll listeners.
  const current = useRef<BlockDrag | null>(null);
  const [drag, setDragState] = useState<BlockDrag | null>(null);
  const setDrag = useCallback((next: BlockDrag | null) => {
    current.current = next;
    setDragState(next);
  }, []);

  const start = (event: PointerEvent<HTMLElement>, mode: BlockDrag["mode"]) => {
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
    setDrag(dragTo(held, event.clientX, event.clientY, area.current?.scrollTop ?? held.scrollTop, hourPx));
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
  const cancel = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse") setDrag(null);
  };

  // A held block follows the grid when it scrolls (by the edge or the mouse wheel).
  const holding = drag !== null;
  useEffect(() => {
    const el = area.current;
    if (!holding || !el) return undefined;
    const follow = () => {
      const held = current.current;
      if (held) setDrag(dragTo(held, held.atX, held.atY, el.scrollTop, hourPx));
    };
    el.addEventListener("scroll", follow, { passive: true });
    return () => el.removeEventListener("scroll", follow);
  }, [holding, area, setDrag, hourPx]);
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
      setDrag(dragTo(held, touch.clientX, touch.clientY, area.current?.scrollTop ?? held.scrollTop, hourPx));
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
  }, [area, setDrag, hourPx]);

  return { drag, ref, start, move, end, cancel };
}
