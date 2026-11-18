import { createHash, randomBytes } from "node:crypto";
import {
  addDays,
  type BlockOccurrence,
  isValidTimeZone,
  type TimeBlock,
  toLocalDate,
} from "@organizer/shared";
import { eq } from "drizzle-orm";
import type { Clock } from "../clock.ts";
import { accounts, calendarFeeds } from "../db/auth-schema.ts";
import type { Db } from "../db/index.ts";
import { listRepeatOccurrences } from "./block-series.ts";
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
  const ctx = { db, clock, timeZone, accountId: account.id };
  const range = { from: addDays(today, -PAST_DAYS), to: addDays(today, FUTURE_DAYS) };
  const blocks = listBlocks(ctx, range);
  // Planned time that repeats with a todo: one event per date (moved ones at their new time).
  const planned = listRepeatOccurrences(ctx, range);
  const base = options.webOrigin ? `${options.webOrigin}/u/${account.username}` : null;
  return toIcs(blocks, { now, todoUrl: base ? (id) => `${base}/todos/${id}` : null, planned });
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

/** One VEVENT: a time block, or a date of a todo's planned time. */
interface FeedEvent {
  uid: string;
  modified: string;
  startAt: string;
  endAt: string;
  title: string;
  done: boolean;
  project: string | null;
  todoId: number | null;
}

const blockEvent = (block: TimeBlock): FeedEvent => ({
  uid: `block-${block.id}-${block.createdAt.replace(/\D/g, "")}`,
  modified: block.updatedAt,
  startAt: block.startAt,
  endAt: block.endAt,
  title: block.todo?.title ?? block.title,
  done: block.todo?.status === "done",
  project: block.project?.name ?? null,
  todoId: block.todo?.id ?? null,
});

/** The UID stays the same for a date as long as the planned time exists (its series and original date). */
const plannedEvent = (o: BlockOccurrence, now: Date): FeedEvent => ({
  uid: `plan-${o.seriesId}-${o.occursOn.replace(/-/g, "")}`,
  modified: now.toISOString(),
  startAt: o.startAt,
  endAt: o.endAt,
  title: o.todo.title,
  done: o.todo.status === "done",
  project: o.project?.name ?? null,
  todoId: o.todo.id,
});

export function toIcs(
  blocks: readonly TimeBlock[],
  options: {
    now: Date;
    todoUrl: ((todoId: number) => string) | null;
    planned?: readonly BlockOccurrence[];
  },
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
  const events = [
    ...blocks.map(blockEvent),
    ...(options.planned ?? []).map((o) => plannedEvent(o, options.now)),
  ].toSorted((a, b) => a.startAt.localeCompare(b.startAt) || a.uid.localeCompare(b.uid));
  for (const event of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.uid}@sloppanizer`,
      `DTSTAMP:${stamp}`,
      `LAST-MODIFIED:${icsTime(event.modified)}`,
      `DTSTART:${icsTime(event.startAt)}`,
      `DTEND:${icsTime(event.endAt)}`,
      `SUMMARY:${icsText(event.done ? `✓ ${event.title}` : event.title)}`,
    );
    if (event.project) lines.push(`CATEGORIES:${icsText(event.project)}`);
    if (event.todoId !== null && options.todoUrl) {
      const url = options.todoUrl(event.todoId);
      lines.push(`URL:${url}`, `DESCRIPTION:${icsText(`#${event.todoId} in Sloppanizer: ${url}`)}`);
    }
    lines.push("TRANSP:OPAQUE", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
