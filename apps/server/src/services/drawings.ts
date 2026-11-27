import {
  type Attachment,
  type CreatedDrawHandoff,
  DRAW_HANDOFF_MINUTES,
  DRAW_TOKEN,
  DRAWING_NAME_PREFIX,
  type DrawHandoff,
  isValidTimeZone,
} from "@organizer/shared";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNotNull, like, lte } from "drizzle-orm";
import type { Clock } from "../clock.ts";
import { drawHandoffs } from "../db/auth-schema.ts";
import type { Db } from "../db/index.ts";
import { attachments } from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import { getAccount } from "./accounts.ts";
import { accountFilesDir, detectType, getAttachment, storeAttachment, toAttachment } from "./attachments.ts";
import type { Ctx, Scoped } from "./context.ts";
import { owned } from "./owned.ts";
import { openSpace } from "./spaces.ts";

/**
 * Drawings (S5#17). A drawing is an ordinary PNG attachment named "drawing-….png"; its strokes ride
 * inside the PNG (a text chunk the web app writes and reads), so the server stores nothing beyond the
 * file. "Draw on your phone" is a hand-off: the computer asks for a token, shows it in a QR code, and a
 * phone without a session sends exactly one PNG with it into the account the computer is working in.
 */

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const MINUTE = 60_000;
/** Expired hand-offs stay this long (the computer can still read "expired"), then they are deleted. */
const KEEP_EXPIRED_MS = 60 * MINUTE;

export const LINK_GONE =
  "This drawing link has expired or was already used. On the computer, open Draw on your phone again for a new code.";

/** Drawings of the account, newest first (attachments named drawing-….png). */
export function recentDrawings(sc: Scoped, limit: number): Attachment[] {
  return sc.db
    .select()
    .from(attachments)
    .where(
      owned(
        sc,
        attachments,
        eq(attachments.mimeType, "image/png"),
        like(attachments.name, `${DRAWING_NAME_PREFIX}%`),
      ),
    )
    .orderBy(desc(attachments.createdAt), desc(attachments.id))
    .limit(limit)
    .all()
    .map(toAttachment);
}

/**
 * Clears the tokens of expired hand-offs (they can never be used again) and deletes those expired over
 * an hour ago. Runs with every hand-off call, so no job is needed.
 */
export function pruneHandoffs(db: Db, clock: Clock): void {
  const now = clock();
  db.update(drawHandoffs)
    .set({ tokenHash: null })
    .where(and(isNotNull(drawHandoffs.tokenHash), lte(drawHandoffs.expiresAt, now.toISOString())))
    .run();
  db.delete(drawHandoffs)
    .where(lte(drawHandoffs.expiresAt, new Date(now.getTime() - KEEP_EXPIRED_MS).toISOString()))
    .run();
}

/**
 * A new hand-off into the caller's account (`ctx.accountId`, a shared project's inside one) for the user
 * `creatorId`. The raw token is returned once; only its sha256 is stored.
 */
export function createHandoff(ctx: Ctx, creatorId: number, actor: string): CreatedDrawHandoff {
  pruneHandoffs(ctx.db, ctx.clock);
  const raw = randomBytes(32).toString("base64url");
  const now = ctx.clock();
  const expiresAt = new Date(now.getTime() + DRAW_HANDOFF_MINUTES * MINUTE).toISOString();
  const row = ctx.db
    .insert(drawHandoffs)
    .values({
      accountId: ctx.accountId,
      creatorId,
      actor,
      tokenHash: sha256(raw),
      createdAt: now.toISOString(),
      expiresAt,
    })
    .returning({ id: drawHandoffs.id })
    .get();
  return { id: row.id, token: raw, expiresAt };
}

type HandoffRow = typeof drawHandoffs.$inferSelect;

/** The caller's own hand-off in this account, or 404 (another user's or another account's never shows). */
function ownHandoff(ctx: Ctx, creatorId: number, id: number): HandoffRow {
  const row = ctx.db
    .select()
    .from(drawHandoffs)
    .where(
      and(
        eq(drawHandoffs.id, id),
        eq(drawHandoffs.accountId, ctx.accountId),
        eq(drawHandoffs.creatorId, creatorId),
      ),
    )
    .get();
  if (!row) throw new ApiError("not_found", "That phone link does not exist any more. Make a new one.");
  return row;
}

/** What the computer polls: waiting, received (with the drawing) or expired. */
export function handoffStatus(ctx: Ctx, creatorId: number, id: number): DrawHandoff {
  pruneHandoffs(ctx.db, ctx.clock);
  const row = ownHandoff(ctx, creatorId, id);
  if (row.attachmentId !== null) {
    let attachment: Attachment | null = null;
    try {
      attachment = getAttachment(ctx, row.attachmentId);
    } catch {
      // Deleted meanwhile: report it as expired, there is nothing to insert.
    }
    if (attachment) return { id: row.id, status: "received", expiresAt: row.expiresAt, attachment };
  }
  const expired = Date.parse(row.expiresAt) <= ctx.clock().getTime() || row.attachmentId !== null;
  return { id: row.id, status: expired ? "expired" : "waiting", expiresAt: row.expiresAt, attachment: null };
}

/** The computer closed the dialog: the link stops working at once (a drawing already sent stays stored). */
export function cancelHandoff(ctx: Ctx, creatorId: number, id: number): void {
  const row = ownHandoff(ctx, creatorId, id);
  ctx.db.delete(drawHandoffs).where(eq(drawHandoffs.id, row.id)).run();
}

/**
 * The open hand-off of a raw token, while it can still be used: unexpired, unused, and its creator still
 * active and (in a shared project) still a member. Otherwise one 404 for every reason, so the phone learns
 * nothing about other links.
 */
function usableHandoff(db: Db, clock: Clock, raw: string | undefined): HandoffRow {
  pruneHandoffs(db, clock);
  if (raw === undefined || !DRAW_TOKEN.test(raw)) throw new ApiError("not_found", LINK_GONE);
  const row = db
    .select()
    .from(drawHandoffs)
    .where(eq(drawHandoffs.tokenHash, sha256(raw)))
    .get();
  if (!row || row.attachmentId !== null || Date.parse(row.expiresAt) <= clock().getTime()) {
    throw new ApiError("not_found", LINK_GONE);
  }
  const creator = getAccount(db, row.creatorId);
  const target = getAccount(db, row.accountId);
  const allowed =
    creator?.status === "active" &&
    target?.status === "active" &&
    (row.accountId === row.creatorId || openSpace(db, creator, row.accountId) !== null);
  if (!allowed) throw new ApiError("not_found", LINK_GONE);
  return row;
}

/** What the phone sees before drawing. */
export function phoneHandoff(db: Db, clock: Clock, raw: string | undefined): { expiresAt: string } {
  return { expiresAt: usableHandoff(db, clock, raw).expiresAt };
}

/** "drawing-2026-11-27-1032.png" in the creator's time zone. */
export function drawingName(at: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return `${DRAWING_NAME_PREFIX}${parts.year}-${parts.month}-${parts.day}-${parts.hour}${parts.minute}.png`;
}

/**
 * The phone sends its drawing: a PNG, stored as an attachment of the hand-off's account (its quota
 * applies), then the token is cleared so the link works only once. better-sqlite3 is synchronous and so is
 * this function, so no other request runs between the check and the clearing.
 */
export function receiveDrawing(
  env: { db: Db; clock: Clock; filesDir: string; filesLimitBytes: number; fallbackTimeZone: string },
  raw: string | undefined,
  bytes: Buffer,
): { accountId: number } {
  const row = usableHandoff(env.db, env.clock, raw);
  if (bytes.length === 0 || detectType(bytes).mime !== "image/png") {
    throw new ApiError("unsupported_type", "Only a PNG drawing can be sent here.");
  }
  const creator = getAccount(env.db, row.creatorId);
  const zone = creator && isValidTimeZone(creator.timeZone) ? creator.timeZone : env.fallbackTimeZone;
  const ctx: Ctx = { db: env.db, clock: env.clock, timeZone: zone, accountId: row.accountId };
  const attachment = storeAttachment(
    ctx,
    { dir: accountFilesDir(env.filesDir, row.accountId), limitBytes: env.filesLimitBytes },
    row.actor,
    drawingName(env.clock(), zone),
    bytes,
  );
  env.db
    .update(drawHandoffs)
    .set({ tokenHash: null, receivedAt: env.clock().toISOString(), attachmentId: attachment.id })
    .where(eq(drawHandoffs.id, row.id))
    .run();
  return { accountId: row.accountId };
}
