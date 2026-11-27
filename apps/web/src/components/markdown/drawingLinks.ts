import { API_PREFIX, DRAWING_NAME_PREFIX } from "@organizer/shared";

/** Drawings link like any image; the alt text says what it is, the file name stays in the link. */
export const drawingMarkdown = (url: string): string => `![Drawing](${url})`;

/** An attachment image made with Draw: "/api/v1/attachments/<id>/drawing-….png". */
export const isDrawingSrc = (src: unknown): src is string =>
  typeof src === "string" &&
  !src.includes("..") &&
  new RegExp(`^${API_PREFIX}/attachments/\\d+/${DRAWING_NAME_PREFIX}[A-Za-z0-9._-]*\\.png$`).test(src);

/**
 * The text with every link target `from` replaced by `to` (an edited drawing is a new file). Only whole
 * link targets "](from)" change, never the same characters elsewhere in the text.
 */
export const replaceLinkTarget = (text: string, from: string, to: string): string =>
  text.split(`](${from})`).join(`](${to})`);
