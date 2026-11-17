import { type MouseEvent, type PointerEvent, useState } from "react";
import { snap } from "./planner.ts";

export interface DragTodo {
  id: number;
  title: string;
}

export interface TodoDrag {
  todo: DragTodo;
  x: number;
  y: number;
  /** Past the 6px threshold: a drag, not a click. */
  active: boolean;
  /** The slot under the pointer: a day column and the start in minutes after midnight. */
  target: { day: string; startMin: number } | null;
}

/** The day column ([data-day]) under a point and the snapped start of a block dropped there. */
export function slotAt(x: number, y: number, hourPx: number): { day: string; startMin: number } | null {
  const column = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-day]");
  const day = column?.dataset.day;
  if (!column || !day) return null;
  const top = column.getBoundingClientRect().top;
  const minutes = snap(((y - top) / hourPx) * 60 - 15);
  return { day, startMin: Math.max(0, Math.min(23 * 60, minutes)) };
}

/**
 * Drag a todo onto the planner's days: with a mouse from anywhere, on touch screens only from sources
 * that allow it (they need touch-action: none, so they cannot start a scroll). A press without moving is
 * a click.
 */
export function useTodoDrag(options: {
  hourPx: number;
  onDrop: (todo: DragTodo, day: string, startMin: number) => void;
  onClick: (todo: DragTodo) => void;
}) {
  const [drag, setDrag] = useState<TodoDrag | null>(null);
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);

  const bind = (todo: DragTodo, { touch = false }: { touch?: boolean } = {}) => ({
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType === "mouse" ? event.button !== 0 : !touch) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      setOrigin({ x: event.clientX, y: event.clientY });
      setDrag({ todo, x: event.clientX, y: event.clientY, active: false, target: null });
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      if (!drag || !origin) return;
      const moved = Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 6;
      if (!drag.active && !moved) return;
      setDrag({
        ...drag,
        x: event.clientX,
        y: event.clientY,
        active: true,
        target: slotAt(event.clientX, event.clientY, options.hourPx),
      });
    },
    onPointerUp: () => {
      if (!drag) return;
      setDrag(null);
      setOrigin(null);
      if (!drag.active) options.onClick(drag.todo);
      else if (drag.target) options.onDrop(drag.todo, drag.target.day, drag.target.startMin);
    },
    onPointerCancel: () => {
      setDrag(null);
      setOrigin(null);
    },
    // Keyboard (Enter, Space) still opens the plan dialog; pointer clicks are handled on pointer up.
    onClick: (event: MouseEvent<HTMLElement>) => {
      if (event.detail === 0) options.onClick(todo);
    },
  });

  /** Finds the slot under the pointer again after the calendar scrolled beneath it. */
  const retarget = () => {
    if (drag?.active) setDrag({ ...drag, target: slotAt(drag.x, drag.y, options.hourPx) });
  };

  return { drag, bind, retarget };
}
