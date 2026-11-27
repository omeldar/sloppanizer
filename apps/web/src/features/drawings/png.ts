/**
 * The strokes of a drawing travel inside its PNG as a tEXt chunk, so a drawing stays editable wherever the
 * file goes (copies into shared projects, exports, restores) without any table on the server. Plain bytes,
 * no canvas: tested in Node.
 */

/** The chunk's keyword (Latin-1, printable). */
export const STROKES_KEYWORD = "Sloppanizer drawing";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export const isPng = (bytes: Uint8Array): boolean =>
  bytes.length >= 8 && SIGNATURE.every((b, i) => bytes[i] === b);

interface Chunk {
  type: string;
  /** Offset of the chunk's length field. */
  start: number;
  data: Uint8Array;
}

/** The chunks of a PNG, or [] when the bytes are not one (or are cut short). */
function chunksOf(bytes: Uint8Array): Chunk[] {
  if (!isPng(bytes)) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Chunk[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return [];
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    chunks.push({ type, start: offset, data: bytes.subarray(offset + 8, offset + 8 + length) });
    offset = end;
    if (type === "IEND") break;
  }
  return chunks;
}

const latin1 = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);

/**
 * The PNG with `text` (ASCII, e.g. JSON) in a tEXt chunk under the keyword, just before IEND. An old chunk
 * with the same keyword is left out. Returns the bytes unchanged when they are not a PNG.
 */
export function withTextChunk(png: Uint8Array, text: string, keyword = STROKES_KEYWORD): Uint8Array {
  const chunks = chunksOf(png);
  const iend = chunks.find((c) => c.type === "IEND");
  if (!iend) return png;
  const data = latin1(`${keyword}\0${text}`);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(latin1("tEXt"), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  const kept = chunks.filter((c) => c.type !== "IEND" && textOf(c, keyword) === null);
  const parts = [
    png.subarray(0, 8),
    ...kept.map((c) => png.subarray(c.start, c.start + 12 + c.data.length)),
    chunk,
    png.subarray(iend.start, iend.start + 12),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function textOf(chunk: Chunk, keyword: string): string | null {
  if (chunk.type !== "tEXt") return null;
  const zero = chunk.data.indexOf(0);
  if (zero === -1) return null;
  const name = String.fromCharCode(...chunk.data.subarray(0, zero));
  if (name !== keyword) return null;
  let text = "";
  // Chunks can be large: decode in slices (spread arguments have a limit).
  for (let i = zero + 1; i < chunk.data.length; i += 8192) {
    text += String.fromCharCode(...chunk.data.subarray(i, Math.min(chunk.data.length, i + 8192)));
  }
  return text;
}

/** The text of the keyword's tEXt chunk, or null (not a PNG, no such chunk). */
export function readTextChunk(png: Uint8Array, keyword = STROKES_KEYWORD): string | null {
  for (const chunk of chunksOf(png)) {
    const text = textOf(chunk, keyword);
    if (text !== null) return text;
  }
  return null;
}
