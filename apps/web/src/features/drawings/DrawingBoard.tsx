import { type KeyboardEvent, type PointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import styles from "./Drawings.module.css";
import type { Drawing } from "./history.ts";
import { drawPage, drawStroke, PEN_COLORS, PEN_SIZES, type Stroke } from "./model.ts";

interface Props {
  drawing: Drawing;
  /** Fills the screen (the phone page) instead of fitting into a dialog. */
  fullScreen?: boolean;
  /** Text for screen readers on the canvas. */
  label?: string;
}

/** Smallest step between two stored points, in drawing units (keeps the JSON small). */
const MIN_STEP = 1.5;

interface Live {
  pointerId: number;
  stroke: Stroke;
  /** Points already on the canvas. */
  drawn: number;
}

/**
 * The drawing surface: pen colours, sizes, eraser, undo, redo and clear above a canvas that takes mouse,
 * finger and pen (with pressure) through Pointer Events. `touch-action: none` keeps the page from
 * scrolling under the pen, and once a pen has touched the canvas, fingers and palms are ignored.
 */
export function DrawingBoard({ drawing, fullScreen = false, label = "Drawing canvas" }: Props) {
  const [color, setColor] = useState<string>(PEN_COLORS[0].value);
  const [size, setSize] = useState<number>(PEN_SIZES[1].value);
  const [eraser, setEraser] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef<Live | null>(null);
  const penSeen = useRef(false);
  const [fit, setFit] = useState({ width: 0, height: 0 });
  const { page } = drawing;

  // The canvas keeps the page's shape and fills the space it has.
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth || 640;
      const height = element.clientHeight || width / (page.width / page.height);
      const scale = Math.min(width / page.width, height / page.height);
      setFit({ width: Math.floor(page.width * scale), height: Math.floor(page.height * scale) });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [page.width, page.height]);

  const context = () => {
    const element = canvas.current;
    const pen = element?.getContext("2d") ?? null;
    if (!element || !pen) return null;
    const scale = element.width / page.width;
    pen.setTransform(scale, 0, 0, scale, 0, 0);
    return pen;
  };

  // Every finished stroke, undo, redo or clear draws the page again.
  useEffect(() => {
    const element = canvas.current;
    if (!element || fit.width === 0) return;
    const ratio = window.devicePixelRatio || 1;
    element.width = Math.round(fit.width * ratio);
    element.height = Math.round(fit.height * ratio);
    const pen = context();
    if (pen) drawPage(pen, page);
    // context() reads the page and canvas given here.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [page, fit]);

  /** A pointer position as a point of the page (pressure only from a pen). */
  const pointAt = (
    element: HTMLCanvasElement,
    sample: { clientX: number; clientY: number; pressure: number },
    pointerType: string,
  ): [number, number, number] => {
    const rect = element.getBoundingClientRect();
    const x = ((sample.clientX - rect.left) / (rect.width || 1)) * page.width;
    const y = ((sample.clientY - rect.top) / (rect.height || 1)) * page.height;
    // Mice and fingers report 0.5 (or 0); only a pen's pressure changes the width.
    const pressure = pointerType === "pen" && sample.pressure > 0 ? sample.pressure : 0.5;
    return [
      Math.round(Math.min(page.width, Math.max(0, x))),
      Math.round(Math.min(page.height, Math.max(0, y))),
      Math.round(pressure * 100),
    ];
  };

  const ignored = (event: PointerEvent<HTMLCanvasElement>) =>
    !event.isPrimary ||
    (event.pointerType === "mouse" && event.button !== 0) ||
    (event.pointerType === "touch" && penSeen.current);

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === "pen") penSeen.current = true;
    if (live.current || ignored(event)) return;
    event.preventDefault();
    try {
      // Keeps the line going when the pen leaves the canvas; refused for pointers the browser does not know.
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Drawing still works without it.
    }
    const stroke: Stroke = {
      color,
      size,
      eraser,
      points: pointAt(event.currentTarget, event, event.pointerType),
    };
    live.current = { pointerId: event.pointerId, stroke, drawn: 0 };
    const pen = context();
    if (pen) drawStroke(pen, stroke);
    live.current.drawn = 1;
  };

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const current = live.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault();
    const native = event.nativeEvent as globalThis.PointerEvent;
    const events = typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
    const samples = events.length > 0 ? events : [native];
    const points = current.stroke.points;
    for (const sample of samples) {
      const point = pointAt(event.currentTarget, sample, event.pointerType);
      const lastX = points[points.length - 3] as number;
      const lastY = points[points.length - 2] as number;
      if (Math.hypot(point[0] - lastX, point[1] - lastY) < MIN_STEP) continue;
      points.push(...point);
    }
    const pen = context();
    if (pen && points.length / 3 > current.drawn) {
      drawStroke(pen, current.stroke, current.drawn);
      current.drawn = points.length / 3;
    }
  };

  const finish = (event: PointerEvent<HTMLCanvasElement>) => {
    const current = live.current;
    if (!current || current.pointerId !== event.pointerId) return;
    live.current = null;
    drawing.addStroke(current.stroke);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "z" && !event.shiftKey) drawing.undo();
    else if ((key === "z" && event.shiftKey) || key === "y") drawing.redo();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    // The shortcuts work while anything in the board has focus (its buttons, the canvas).
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions
    <div className={styles.board} data-full={fullScreen || undefined} onKeyDown={onKeyDown}>
      <div className={styles.tools} role="toolbar" aria-label="Drawing tools">
        <div className={styles.toolGroup} role="group" aria-label="Pen colour">
          {PEN_COLORS.map((c) => (
            <button
              key={c.value}
              type="button"
              className={styles.swatch}
              style={{ background: c.value }}
              aria-label={c.name}
              aria-pressed={!eraser && color === c.value}
              onClick={() => {
                setColor(c.value);
                setEraser(false);
              }}
            />
          ))}
        </div>
        <div className={styles.toolGroup} role="group" aria-label="Pen size">
          {PEN_SIZES.map((s) => (
            <button
              key={s.value}
              type="button"
              className={styles.sizeButton}
              aria-label={s.name}
              aria-pressed={size === s.value}
              onClick={() => setSize(s.value)}
            >
              <span style={{ width: 4 + s.value / 2, height: 4 + s.value / 2 }} />
            </button>
          ))}
        </div>
        <div className={styles.toolGroup}>
          <button
            type="button"
            className={styles.toolButton}
            aria-pressed={eraser}
            onClick={() => setEraser((on) => !on)}
          >
            Eraser
          </button>
          <button
            type="button"
            className={styles.toolButton}
            disabled={!drawing.canUndo}
            onClick={drawing.undo}
            title="Undo (ctrl+z)"
          >
            Undo
          </button>
          <button
            type="button"
            className={styles.toolButton}
            disabled={!drawing.canRedo}
            onClick={drawing.redo}
            title="Redo (ctrl+shift+z)"
          >
            Redo
          </button>
          <button
            type="button"
            className={styles.toolButton}
            disabled={page.strokes.length === 0 && page.background === null}
            onClick={drawing.clear}
          >
            Clear
          </button>
        </div>
      </div>
      <div ref={box} className={styles.canvasBox}>
        <canvas
          ref={canvas}
          className={styles.canvas}
          style={{ width: fit.width || undefined, height: fit.height || undefined }}
          role="img"
          aria-label={label}
          data-eraser={eraser || undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finish}
          onPointerCancel={finish}
          onLostPointerCapture={finish}
        />
      </div>
    </div>
  );
}
