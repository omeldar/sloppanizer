import { decodeStrokes, drawPage, encodeStrokes, type Page } from "./model.ts";
import { readTextChunk, withTextChunk } from "./png.ts";

/** A background picture is scaled to at most this on its long side. */
const MAX_BACKGROUND = 2000;

/**
 * The page as a PNG at its own size, with its strokes in a text chunk so it can be edited again. A page
 * with a background (a picture without strokes) is stored flat: next time the whole PNG is the
 * background again, so nothing of it is ever lost.
 */
export async function pagePng(page: Page): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = page.width;
  canvas.height = page.height;
  const pen = canvas.getContext("2d");
  if (!pen) throw new Error("This browser cannot make pictures. Try another browser.");
  drawPage(pen, page);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The picture could not be made. Try again.");
  if (page.background) return blob;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return new Blob([withTextChunk(bytes, encodeStrokes(page)) as BlobPart], { type: "image/png" });
}

/**
 * A stored drawing as a page: its strokes when the PNG carries them, else the picture itself as the
 * background to draw on.
 */
export async function pageFromPng(blob: Blob): Promise<Page> {
  const text = readTextChunk(new Uint8Array(await blob.arrayBuffer()));
  const page = text === null ? null : decodeStrokes(text);
  if (page) return page;
  const picture = await loadPicture(blob);
  const scale = Math.min(1, MAX_BACKGROUND / Math.max(picture.width, picture.height, 1));
  return {
    width: Math.max(50, Math.round(picture.width * scale)),
    height: Math.max(50, Math.round(picture.height * scale)),
    strokes: [],
    background: picture,
  };
}

async function loadPicture(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") return createImageBitmap(blob);
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}
