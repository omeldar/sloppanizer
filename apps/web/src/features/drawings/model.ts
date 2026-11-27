import { z } from "zod";

/**
 * A drawing: strokes on a white page of a fixed size in drawing units (the canvas on screen scales it).
 * Each stroke is one pen or eraser line; its points are x, y and pressure (0 to 100) in a flat list, so
 * the JSON in the PNG stays small. The eraser paints the page colour, which also covers a background.
 */

export const PAGE_COLOR = "#ffffff";

export const PEN_COLORS = [
  { value: "#111827", name: "Black" },
  { value: "#2563eb", name: "Blue" },
  { value: "#dc2626", name: "Red" },
  { value: "#16a34a", name: "Green" },
  { value: "#ea580c", name: "Orange" },
  { value: "#7c3aed", name: "Purple" },
] as const;

export const PEN_SIZES = [
  { value: 3, name: "Fine" },
  { value: 6, name: "Medium" },
  { value: 12, name: "Thick" },
  { value: 24, name: "Marker" },
] as const;

/** The eraser is wider than the pen of the same size. */
export const ERASER_SCALE = 3;

export interface Stroke {
  color: string;
  size: number;
  eraser: boolean;
  /** x, y, pressure (0..100), x, y, pressure, ... */
  points: number[];
}

/** A picture under the strokes: a PNG without strokes data that was opened to draw on. */
export type Background = CanvasImageSource & { width: number; height: number };

export interface Page {
  width: number;
  height: number;
  strokes: readonly Stroke[];
  background: Background | null;
}

/** A new page: landscape on wide screens, portrait on tall ones, 1600 units on the long side. */
export function newPage(aspect = 1.6): Page {
  const long = 1600;
  const ratio = Math.min(2.4, Math.max(1, aspect >= 1 ? aspect : 1 / aspect));
  const short = Math.round(long / ratio);
  return aspect >= 1
    ? { width: long, height: short, strokes: [], background: null }
    : { width: short, height: long, strokes: [], background: null };
}

const Color = z.string().regex(/^#[0-9a-f]{6}$/i);
const StoredStroke = z.tuple([
  Color,
  z.number().min(0.5).max(200),
  z.union([z.literal(0), z.literal(1)]),
  z.array(z.number().finite()).max(300_000),
]);
const StoredDrawing = z.strictObject({
  v: z.literal(1),
  w: z.number().int().min(50).max(4000),
  h: z.number().int().min(50).max(4000),
  s: z.array(StoredStroke).max(20_000),
});

/** The strokes as compact JSON (what goes into the PNG). */
export function encodeStrokes(page: Page): string {
  return JSON.stringify({
    v: 1,
    w: page.width,
    h: page.height,
    s: page.strokes.map((s) => [s.color, s.size, s.eraser ? 1 : 0, s.points.map((n) => Math.round(n))]),
  });
}

/** The page of stored strokes, or null when the text is not a drawing this app wrote. */
export function decodeStrokes(text: string): Page | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = StoredDrawing.safeParse(raw);
  if (!parsed.success) return null;
  const { w, h, s } = parsed.data;
  return {
    width: w,
    height: h,
    background: null,
    strokes: s
      .filter(([, , , points]) => points.length >= 3 && points.length % 3 === 0)
      .map(([color, size, eraser, points]) => ({ color, size, eraser: eraser === 1, points })),
  };
}

/** The drawing context calls the renderer needs (a real canvas, or a recording one in tests). */
export type Pen = Pick<
  CanvasRenderingContext2D,
  | "beginPath"
  | "moveTo"
  | "lineTo"
  | "stroke"
  | "arc"
  | "fill"
  | "fillRect"
  | "drawImage"
  | "save"
  | "restore"
  | "setTransform"
> & {
  lineWidth: number;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
};

/** Line width at a point: pressure 50 (mouse, finger) is the size itself; a pen goes thinner and wider. */
export const widthAt = (stroke: Stroke, pressure: number): number =>
  (stroke.eraser ? stroke.size * ERASER_SCALE : stroke.size) * (0.35 + (1.3 * pressure) / 100);

/**
 * Draws a stroke from point `from` on (0: all of it). Each segment gets the width of its two points, with
 * round caps, so a growing line can be drawn piece by piece as the pen moves.
 */
export function drawStroke(pen: Pen, stroke: Stroke, from = 0): void {
  const p = stroke.points;
  const count = p.length / 3;
  const color = stroke.eraser ? PAGE_COLOR : stroke.color;
  pen.lineCap = "round";
  pen.lineJoin = "round";
  if (count === 1) {
    if (from > 0) return;
    pen.fillStyle = color;
    pen.beginPath();
    pen.arc(p[0] as number, p[1] as number, widthAt(stroke, p[2] as number) / 2, 0, Math.PI * 2);
    pen.fill();
    return;
  }
  pen.strokeStyle = color;
  for (let i = Math.max(1, from); i < count; i++) {
    const a = (i - 1) * 3;
    const b = i * 3;
    pen.lineWidth = widthAt(stroke, ((p[a + 2] as number) + (p[b + 2] as number)) / 2);
    pen.beginPath();
    pen.moveTo(p[a] as number, p[a + 1] as number);
    pen.lineTo(p[b] as number, p[b + 1] as number);
    pen.stroke();
  }
}

/** The whole page, in drawing units (the caller sets the scale). */
export function drawPage(pen: Pen, page: Page): void {
  pen.fillStyle = PAGE_COLOR;
  pen.fillRect(0, 0, page.width, page.height);
  if (page.background) pen.drawImage(page.background, 0, 0, page.width, page.height);
  for (const stroke of page.strokes) drawStroke(pen, stroke);
}

export const isBlank = (page: Page): boolean => page.strokes.length === 0 && page.background === null;

export const two = (n: number): string => String(n).padStart(2, "0");

/** "drawing-2026-11-27-1032.png" in local time. */
export function drawingFileName(at = new Date()): string {
  return `drawing-${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}.png`;
}
