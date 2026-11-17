import { type RefObject, useEffect, useRef } from "react";
import { edgeScrollStep } from "./planner.ts";

/**
 * While `point` is set (a drag in progress), scrolls `area` on every frame the point is near its top
 * or bottom edge, so a drag can reach the hours that are scrolled out of view.
 */
export function useEdgeScroll(
  area: RefObject<HTMLElement | null>,
  point: { x: number; y: number } | null,
): void {
  const latest = useRef(point);
  useEffect(() => {
    latest.current = point;
  });
  const active = point !== null;
  useEffect(() => {
    if (!active) return undefined;
    let frame = 0;
    const tick = () => {
      const el = area.current;
      const at = latest.current;
      if (el && at) {
        const step = edgeScrollStep(at, el.getBoundingClientRect());
        if (step !== 0) el.scrollTop += step;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, area]);
}
