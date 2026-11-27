import { z } from "zod";
import { Attachment } from "./entities.ts";
import { Id, Timestamp } from "./primitives.ts";

/**
 * Drawings (S5#17): a drawing is a PNG attachment named "drawing-….png" whose strokes travel inside the
 * file (a PNG text chunk), so it can be edited or copied later. "Draw on your phone" hands one drawing
 * over from a phone without a session, through a short-lived, single-use token.
 */

/** File names of drawings start with this (the recent drawings list looks for it). */
export const DRAWING_NAME_PREFIX = "drawing-";

/** The phone sends its token in this header, never in a URL (URLs end up in logs). */
export const DRAW_TOKEN_HEADER = "x-draw-token";

/** A hand-off token: 32 random bytes, base64url. */
export const DRAW_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** How long a phone link works. */
export const DRAW_HANDOFF_MINUTES = 10;

/** A drawing the phone sends can be up to 10 MiB (a full-screen PNG is far smaller). */
export const MAX_DRAWING_BYTES = 10 * 1024 * 1024;

export const RecentDrawingsQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
export type RecentDrawingsQuery = z.infer<typeof RecentDrawingsQuery>;

export const DrawingList = z.strictObject({ items: z.array(Attachment) });
export type DrawingList = z.infer<typeof DrawingList>;

/** A new hand-off: the token is shown once (in the QR code) and only its hash is stored. */
export const CreatedDrawHandoff = z.strictObject({
  id: Id,
  token: z.string().regex(DRAW_TOKEN),
  expiresAt: Timestamp,
});
export type CreatedDrawHandoff = z.infer<typeof CreatedDrawHandoff>;

export const DrawHandoffStatus = z.enum(["waiting", "received", "expired"]);
export type DrawHandoffStatus = z.infer<typeof DrawHandoffStatus>;

/** What the computer polls: waiting, or the drawing once the phone sent it. */
export const DrawHandoff = z.strictObject({
  id: Id,
  status: DrawHandoffStatus,
  expiresAt: Timestamp,
  attachment: Attachment.nullable(),
});
export type DrawHandoff = z.infer<typeof DrawHandoff>;

/** What the phone learns about its link before drawing: only when it stops working. */
export const PhoneDrawHandoff = z.strictObject({ expiresAt: Timestamp });
export type PhoneDrawHandoff = z.infer<typeof PhoneDrawHandoff>;
