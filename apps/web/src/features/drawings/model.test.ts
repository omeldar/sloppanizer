import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { historyReducer } from "./history.ts";
import {
  decodeStrokes,
  drawStroke,
  encodeStrokes,
  newPage,
  type Page,
  type Pen,
  type Stroke,
  widthAt,
} from "./model.ts";
import { isPng, readTextChunk, STROKES_KEYWORD, withTextChunk } from "./png.ts";
import { tinyPng } from "./testCanvas.ts";

const line: Stroke = {
  color: "#2563eb",
  size: 6,
  eraser: false,
  points: [10, 10, 50, 20.4, 30.6, 80, 40, 40, 50],
};
const page: Page = {
  width: 1600,
  height: 1000,
  background: null,
  strokes: [line, { ...line, eraser: true }],
};

/** The chunks of a PNG as [type, crc ok]. */
function chunks(bytes: Uint8Array): [string, boolean][] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: [string, boolean][] = [];
  for (let at = 8; at < bytes.length;) {
    const length = view.getUint32(at);
    const typeAndData = bytes.subarray(at + 4, at + 8 + length);
    out.push([
      String.fromCharCode(...typeAndData.subarray(0, 4)),
      view.getUint32(at + 8 + length) === crc32(typeAndData),
    ]);
    at += 12 + length;
  }
  return out;
}

describe("strokes inside the PNG", () => {
  it("adds one tEXt chunk with a valid CRC before IEND, and reads it back", () => {
    const png = tinyPng();
    const text = encodeStrokes(page);
    const out = withTextChunk(png, text);
    expect(isPng(out)).toBe(true);
    expect(chunks(out)).toEqual([
      ["IHDR", true],
      ["IDAT", true],
      ["tEXt", true],
      ["IEND", true],
    ]);
    expect(readTextChunk(out)).toBe(text);
    // Writing again replaces the old chunk instead of adding a second.
    const twice = withTextChunk(out, "{}");
    expect(chunks(twice).filter(([type]) => type === "tEXt")).toHaveLength(1);
    expect(readTextChunk(twice)).toBe("{}");
    expect(readTextChunk(png)).toBe(null);
    expect(readTextChunk(png, STROKES_KEYWORD)).toBe(null);
  });

  it("leaves anything that is not a PNG alone", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    expect(withTextChunk(jpeg, "x")).toBe(jpeg);
    expect(readTextChunk(jpeg)).toBe(null);
    // Cut short: no chunks, no crash.
    expect(readTextChunk(tinyPng().subarray(0, 20))).toBe(null);
  });

  it("round-trips strokes as compact JSON with whole numbers", () => {
    const text = encodeStrokes(page);
    expect(text).toBe(
      '{"v":1,"w":1600,"h":1000,"s":[["#2563eb",6,0,[10,10,50,20,31,80,40,40,50]],["#2563eb",6,1,[10,10,50,20,31,80,40,40,50]]]}',
    );
    const back = decodeStrokes(text);
    expect(back?.strokes.map((s) => s.eraser)).toEqual([false, true]);
    expect(back).toMatchObject({ width: 1600, height: 1000, background: null });
  });

  it("refuses text that is not a drawing", () => {
    for (const bad of [
      "",
      "nope",
      "{}",
      '{"v":2,"w":10,"h":10,"s":[]}',
      '{"v":1,"w":1600,"h":1000,"s":[["red",6,0,[1,2,3]]]}',
    ]) {
      expect(decodeStrokes(bad)).toBe(null);
    }
    // Broken point lists are dropped, the rest stays.
    expect(
      decodeStrokes('{"v":1,"w":1600,"h":1000,"s":[["#000000",6,0,[1,2]],["#000000",6,0,[1,2,3]]]}')?.strokes,
    ).toHaveLength(1);
  });
});

describe("drawing", () => {
  it("draws each segment with the width of its points and the page colour for the eraser", () => {
    const calls: string[] = [];
    const pen = {
      beginPath: () => calls.push("begin"),
      moveTo: (x: number, y: number) => calls.push(`move ${x},${y}`),
      lineTo: (x: number, y: number) => calls.push(`line ${x},${y}`),
      stroke: function (this: Pen) {
        calls.push(`stroke ${String(this.strokeStyle)} ${this.lineWidth.toFixed(1)}`);
      },
    } as unknown as Pen;
    drawStroke(pen, line);
    drawStroke(pen, { ...line, eraser: true, points: [0, 0, 50, 5, 5, 50] });
    expect(calls).toEqual([
      "begin",
      "move 10,10",
      "line 20.4,30.6",
      `stroke #2563eb ${widthAt(line, 65).toFixed(1)}`,
      "begin",
      "move 20.4,30.6",
      "line 40,40",
      `stroke #2563eb ${widthAt(line, 65).toFixed(1)}`,
      "begin",
      "move 0,0",
      "line 5,5",
      "stroke #ffffff 18.0",
    ]);
  });

  it("makes a pen thinner when light and wider when hard, a mouse at its size", () => {
    expect(widthAt(line, 50)).toBeCloseTo(6);
    expect(widthAt(line, 10)).toBeLessThan(3);
    expect(widthAt(line, 100)).toBeGreaterThan(9);
  });

  it("starts landscape or portrait, 1600 on the long side", () => {
    expect(newPage(1.6)).toMatchObject({ width: 1600, height: 1000 });
    expect(newPage(0.5)).toMatchObject({ width: 800, height: 1600 });
    expect(newPage(10)).toMatchObject({ width: 1600, height: 667 });
  });

  it("undoes and redoes strokes, clear and a loaded copy", () => {
    const start = { past: [], present: { ...page, strokes: [] }, future: [] };
    let h = historyReducer(start, { type: "stroke", stroke: line });
    h = historyReducer(h, { type: "stroke", stroke: line });
    h = historyReducer(h, { type: "clear" });
    expect(h.present.strokes).toHaveLength(0);
    h = historyReducer(h, { type: "undo" });
    expect(h.present.strokes).toHaveLength(2);
    h = historyReducer(h, { type: "undo" });
    expect(h.present.strokes).toHaveLength(1);
    h = historyReducer(h, { type: "redo" });
    expect(h.present.strokes).toHaveLength(2);
    h = historyReducer(h, { type: "load", page });
    expect(h.future).toEqual([]);
    expect(historyReducer(start, { type: "undo" })).toBe(start);
    expect(historyReducer(start, { type: "clear" })).toBe(start);
  });
});
