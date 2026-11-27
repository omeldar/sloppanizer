import { crc32 } from "node:zlib";
import { vi } from "vitest";

function chunk(type: string, data: number[]): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), Buffer.from(data)]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A real 1x1 PNG (signature, IHDR, IDAT, IEND), what a canvas would hand back. */
export function tinyPng(): Uint8Array {
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
      chunk("IDAT", [0x78, 0x9c, 0x63, 0xf8, 0xff, 0xff, 0x3f, 0x00, 0x05, 0xfe, 0x02, 0xfe]),
      chunk("IEND", []),
    ]),
  );
}

/**
 * jsdom has no canvas: a recording 2D context, toBlob with a tiny PNG and an 800x500 layout box, so the
 * board can be drawn on with pointer events.
 */
export function stubCanvas() {
  const calls: string[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push(`${name}(${args.map((a) => (typeof a === "number" ? Math.round(a) : typeof a)).join(",")})`);
    };
  const pen = {
    lineWidth: 1,
    strokeStyle: "#000000",
    fillStyle: "#000000",
    lineCap: "butt",
    lineJoin: "miter",
    beginPath: record("beginPath"),
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    stroke: record("stroke"),
    arc: record("arc"),
    fill: record("fill"),
    fillRect: record("fillRect"),
    drawImage: record("drawImage"),
    save: record("save"),
    restore: record("restore"),
    setTransform: record("setTransform"),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => pen as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback: BlobCallback) =>
    callback(new Blob([tinyPng() as BlobPart], { type: "image/png" })),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 0, 800, 500),
  );
  return { calls, pen };
}

/** A line of `points` pointer positions on the canvas, from pointerdown to pointerup. */
export function drawLine(
  canvas: Element,
  points: [number, number][],
  fire: { pointerDown: Fire; pointerMove: Fire; pointerUp: Fire },
  options: { pointerType?: string; pressure?: number; pointerId?: number } = {},
) {
  const init = (x: number, y: number) => ({
    clientX: x,
    clientY: y,
    pointerId: options.pointerId ?? 1,
    pointerType: options.pointerType ?? "mouse",
    pressure: options.pressure ?? 0.5,
    isPrimary: true,
    button: 0,
  });
  const [first, ...rest] = points;
  if (!first) return;
  fire.pointerDown(canvas, init(...first));
  for (const point of rest) fire.pointerMove(canvas, init(...point));
  const last = rest.at(-1) ?? first;
  fire.pointerUp(canvas, init(...last));
}

type Fire = (element: Element, init: object) => boolean;
