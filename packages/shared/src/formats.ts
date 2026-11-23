import { z } from "zod";

/**
 * How dates and times are shown to a person, per account. Data and APIs keep "YYYY-MM-DD" and "HH:mm";
 * only text for people uses these. Weeks always start on Monday.
 */

/** "dmy." 31.12.2026, "dmy/" 31/12/2026, "mdy/" 12/31/2026, "ymd-" 2026-12-31. */
export const DATE_FORMATS = ["dmy.", "dmy/", "mdy/", "ymd-"] as const;
export const DateFormat = z.enum(DATE_FORMATS);
export type DateFormat = z.infer<typeof DateFormat>;

/** "24h" shows 15:00, "12h" shows 3:00 PM. Either can be typed. */
export const TIME_FORMATS = ["24h", "12h"] as const;
export const TimeFormat = z.enum(TIME_FORMATS);
export type TimeFormat = z.infer<typeof TimeFormat>;

export interface FormatPrefs {
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
}

export const DEFAULT_FORMATS: FormatPrefs = { dateFormat: "dmy.", timeFormat: "24h" };

/** Regions offered at sign-up; each presets the formats (they can be changed on the account page). */
export const REGIONS = {
  ch: { name: "Switzerland", dateFormat: "dmy.", timeFormat: "24h" },
  de: { name: "Germany", dateFormat: "dmy.", timeFormat: "24h" },
  at: { name: "Austria", dateFormat: "dmy.", timeFormat: "24h" },
  fr: { name: "France", dateFormat: "dmy/", timeFormat: "24h" },
  it: { name: "Italy", dateFormat: "dmy/", timeFormat: "24h" },
  es: { name: "Spain", dateFormat: "dmy/", timeFormat: "24h" },
  nl: { name: "Netherlands", dateFormat: "dmy/", timeFormat: "24h" },
  gb: { name: "United Kingdom", dateFormat: "dmy/", timeFormat: "24h" },
  ie: { name: "Ireland", dateFormat: "dmy/", timeFormat: "24h" },
  au: { name: "Australia", dateFormat: "dmy/", timeFormat: "12h" },
  in: { name: "India", dateFormat: "dmy/", timeFormat: "12h" },
  us: { name: "United States", dateFormat: "mdy/", timeFormat: "12h" },
  ca: { name: "Canada", dateFormat: "ymd-", timeFormat: "12h" },
  se: { name: "Sweden", dateFormat: "ymd-", timeFormat: "24h" },
  jp: { name: "Japan", dateFormat: "ymd-", timeFormat: "24h" },
  iso: { name: "Other (ISO 8601)", dateFormat: "ymd-", timeFormat: "24h" },
} as const satisfies Record<string, { name: string } & FormatPrefs>;
export type Region = keyof typeof REGIONS;
export const Region = z.enum(Object.keys(REGIONS) as [Region, ...Region[]]);

/** The region of a browser locale ("de-CH" -> "ch"), else Switzerland. */
export function regionOf(locale: string | undefined): Region {
  const country = locale?.split(/[-_]/)[1]?.toLowerCase();
  if (country && country in REGIONS) return country as Region;
  const language = locale?.split(/[-_]/)[0]?.toLowerCase();
  if (language === "en") return "us";
  if (language && language in REGIONS) return language as Region;
  return "ch";
}

export const DATE_FORMAT_LABELS: Record<DateFormat, string> = {
  "dmy.": "31.12.2026",
  "dmy/": "31/12/2026",
  "mdy/": "12/31/2026",
  "ymd-": "2026-12-31",
};
export const TIME_FORMAT_LABELS: Record<TimeFormat, string> = { "24h": "15:00", "12h": "3:00 PM" };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DAY_MONTH = /^(?:\d{4}-)?(\d{2})-(\d{2})$/;
const sep = (format: DateFormat) => format.slice(3);

/** "2026-12-31" in the format; anything else is returned as is. */
export function formatDateAs(date: string, format: DateFormat): string {
  const m = ISO_DATE.exec(date);
  if (!m) return date;
  const [, y, mo, d] = m as unknown as [string, string, string, string];
  if (format === "ymd-") return `${y}-${mo}-${d}`;
  if (format === "mdy/") return `${mo}/${d}/${y}`;
  return `${d}${sep(format)}${mo}${sep(format)}${y}`;
}

/** Day and month only ("31.12.", "31/12", "12/31", "12-31") of a date or a year date "12-31". */
export function formatDayMonthAs(date: string, format: DateFormat): string {
  const m = ISO_DAY_MONTH.exec(date);
  if (!m) return date;
  const [, mo, d] = m as unknown as [string, string, string];
  if (format === "dmy.") return `${d}.${mo}.`;
  if (format === "dmy/") return `${d}/${mo}`;
  if (format === "mdy/") return `${mo}/${d}`;
  return `${mo}-${d}`;
}

/** A month "2026-10" as "10.2026", "10/2026" or "2026-10". */
export function formatMonthAs(month: string, format: DateFormat): string {
  const [year, number] = month.split("-");
  if (!number) return month;
  return format === "ymd-" ? `${year}-${number}` : `${number}${format === "dmy." ? "." : "/"}${year}`;
}

/** "15:00" as "15:00" (24h) or "3:00 PM" (12h); "24:00" (an end) stays readable. Anything else as is. */
export function formatTimeAs(time: string, format: TimeFormat): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) return time;
  const hour = Number(m[1]);
  if (format === "24h") return `${String(hour).padStart(2, "0")}:${m[2]}`;
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${m[2]} ${hour % 24 < 12 ? "AM" : "PM"}`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function validDate(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || y < 1000 || y > 9999) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${pad2(mo)}-${pad2(d)}`;
}

/**
 * A typed date in the account's format (separators . / - or space; a two-digit year is 20xx; without a
 * year, this year), or ISO "2026-12-31" always. Null when it is not a complete, real date.
 */
export function parseDateAs(text: string, format: DateFormat, thisYear: number): string | null {
  const trimmed = text.trim();
  const iso = ISO_DATE.exec(trimmed);
  if (iso) return validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const parts = trimmed.split(/[./\-\s]+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d{1,4}$/.test(p))) return null;
  const nums = parts.map(Number);
  let y: number;
  let mo: number;
  let d: number;
  if (format === "ymd-") {
    if (parts.length === 2) [mo, d, y] = [nums[0] as number, nums[1] as number, thisYear];
    else [y, mo, d] = nums as [number, number, number];
  } else {
    const [a, b, c] = nums as [number, number, number | undefined];
    [d, mo] = format === "mdy/" ? [b, a] : [a, b];
    y = c ?? thisYear;
  }
  if (parts.length === 3 && (parts[format === "ymd-" ? 0 : 2] as string).length === 2) y += 2000;
  if (parts.length === 3 && (parts[format === "ymd-" ? 0 : 2] as string).length === 3) return null;
  return validDate(y, mo, d);
}

/**
 * A typed time, 24h or 12h: "15:00", "15.00", "1500", "15", "3pm", "3:30 PM", "3 p.m.". Null when it is
 * not a time. "24:00" is allowed (an end of day).
 */
export function parseTime(text: string): string | null {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/([ap])\.\s*m\.?/g, "$1m")
    .replace(/\./g, ":")
    .replace(/\s+/g, " ");
  const m = /^(\d{1,2})(?::?(\d{2}))?\s*(am|pm|a|p|h)?$/.exec(t);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  const suffix = m[3];
  if (minute > 59) return null;
  if (suffix === "am" || suffix === "a" || suffix === "pm" || suffix === "p") {
    if (hour < 1 || hour > 12) return null;
    const pm = suffix.startsWith("p");
    hour = (hour % 12) + (pm ? 12 : 0);
  } else if (hour > 24 || (hour === 24 && minute > 0)) {
    return null;
  }
  return `${pad2(hour)}:${pad2(minute)}`;
}
