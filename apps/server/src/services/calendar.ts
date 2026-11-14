import { createHash, randomBytes } from "node:crypto";
import { addDays, isValidTimeZone, type TimeBlock, toLocalDate } from "@organizer/shared";
import { eq } from "drizzle-orm";
import type { Clock } from "../clock.ts";
import { accounts, calendarFeeds } from "../db/auth-schema.ts";
import type { Db } from "../db/index.ts";
import { listBlocks } from "./blocks.ts";

/** The planner as an iCalendar feed behind a secret link, for calendar apps to subscribe to. */

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const FEED_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PAST_DAYS = 30;
const FUTURE_DAYS = 90;

export interface FeedStatus {
  active: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
}

export function feedStatus(db: Db, accountId: number): FeedStatus {
  const row = db.select().from(calendarFeeds).where(eq(calendarFeeds.accountId, accountId)).get();
  return { active: Boolean(row), createdAt: row?.createdAt ?? null, lastUsedAt: row?.lastUsedAt ?? null };
}

/** A new secret for the account's feed (the old link stops working). Returns the raw token once. */
export function createFeed(db: Db, clock: Clock, accountId: number): string {
  const raw = randomBytes(32).toString("base64url");
  const values = { tokenHash: sha256(raw), createdAt: clock().toISOString(), lastUsedAt: null };
  db.insert(calendarFeeds)
    .values({ accountId, ...values })
    .onConflictDoUpdate({ target: calendarFeeds.accountId, set: values })
    .run();
  return raw;
}

export function deleteFeed(db: Db, accountId: number): void {
  db.delete(calendarFeeds).where(eq(calendarFeeds.accountId, accountId)).run();
}

/** The feed of a raw token, or null for an unknown token or an account that is not active. */
export function renderFeed(
  db: Db,
  clock: Clock,
  raw: string,
  options: { fallbackTimeZone: string; webOrigin: string | null },
): string | null {
  if (!FEED_TOKEN.test(raw)) return null;
  const feed = db
    .select()
    .from(calendarFeeds)
    .where(eq(calendarFeeds.tokenHash, sha256(raw)))
    .get();
  if (!feed) return null;
  const account = db.select().from(accounts).where(eq(accounts.id, feed.accountId)).get();
  if (!account || account.status !== "active") return null;
  const now = clock();
  // Calendar apps poll often: write the last use at most every 10 minutes.
  if (!feed.lastUsedAt || now.getTime() - Date.parse(feed.lastUsedAt) > 600_000) {
    db.update(calendarFeeds)
      .set({ lastUsedAt: now.toISOString() })
      .where(eq(calendarFeeds.accountId, feed.accountId))
      .run();
  }
  const timeZone = isValidTimeZone(account.timeZone) ? account.timeZone : options.fallbackTimeZone;
  const today = toLocalDate(now, timeZone);
  const blocks = listBlocks(
    { db, clock, timeZone, accountId: account.id },
    { from: addDays(today, -PAST_DAYS), to: addDays(today, FUTURE_DAYS) },
  );
  const base = options.webOrigin ? `${options.webOrigin}/u/${account.username}` : null;
  return toIcs(blocks, { now, todoUrl: base ? (id) => `${base}/todos/${id}` : null });
}

// ---------- iCalendar (RFC 5545) ----------

/** Escapes TEXT values: backslash, semicolon, comma and line breaks. */
export const icsText = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** 20261112T080000Z */
const icsTime = (iso: string): string => iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

/** Folds a content line at 75 octets (continuation lines start with a space), not inside a character. */
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const char of line) {
    const charSize = Buffer.byteLength(char, "utf8");
    const limit = parts.length === 0 ? 75 : 74;
    if (size + charSize > limit) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += charSize;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

export function toIcs(
  blocks: readonly TimeBlock[],
  options: { now: Date; todoUrl: ((todoId: number) => string) | null },
): string {
  const stamp = icsTime(options.now.toISOString());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Sloppanizer//Planner//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Sloppanizer planner",
    "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
    "X-PUBLISHED-TTL:PT15M",
  ];
  for (const block of blocks) {
    const title = block.todo?.title ?? block.title;
    const done = block.todo?.status === "done";
    lines.push(
      "BEGIN:VEVENT",
      `UID:block-${block.id}-${block.createdAt.replace(/\D/g, "")}@sloppanizer`,
      `DTSTAMP:${stamp}`,
      `LAST-MODIFIED:${icsTime(block.updatedAt)}`,
      `DTSTART:${icsTime(block.startAt)}`,
      `DTEND:${icsTime(block.endAt)}`,
      `SUMMARY:${icsText(done ? `✓ ${title}` : title)}`,
    );
    if (block.project) lines.push(`CATEGORIES:${icsText(block.project.name)}`);
    if (block.todo && options.todoUrl) {
      const url = options.todoUrl(block.todo.id);
      lines.push(`URL:${url}`, `DESCRIPTION:${icsText(`#${block.todo.id} in Sloppanizer: ${url}`)}`);
    }
    lines.push("TRANSP:OPAQUE", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
