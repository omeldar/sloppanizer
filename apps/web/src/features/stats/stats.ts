import { addDays, type DoneBucket, WorkStats } from "@organizer/shared";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api.ts";

/** The period presets above the charts; "custom" is any from..to. */
export const PRESETS = [
  { id: "week", label: "This week" },
  { id: "4w", label: "4 weeks" },
  { id: "3m", label: "3 months" },
  { id: "year", label: "This year" },
] as const;
export type Preset = (typeof PRESETS)[number]["id"];

const isoWeekday = (date: string): number => {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
};

/** The days of a preset, ending today. */
export function presetRange(preset: Preset, today: string): { from: string; to: string } {
  if (preset === "week") return { from: addDays(today, 1 - isoWeekday(today)), to: today };
  if (preset === "3m") return { from: addDays(today, -90), to: today };
  if (preset === "year") return { from: `${today.slice(0, 4)}-01-01`, to: today };
  return { from: addDays(today, -27), to: today };
}

/** The period of the URL: a preset, or from..to (both needed, else the default of 4 weeks). */
export function periodOf(
  search: { period?: string; from?: string; to?: string },
  today: string,
): { preset: Preset | "custom"; from: string; to: string } {
  if (search.from && search.to && search.from <= search.to)
    return { preset: "custom", from: search.from, to: search.to };
  const preset = PRESETS.find((p) => p.id === search.period)?.id ?? "4w";
  return { preset, ...presetRange(preset, today) };
}

export const useWorkStats = (from: string, to: string) =>
  useQuery({
    queryKey: ["stats", "work", from, to],
    queryFn: () => api(WorkStats, "/stats/overview", { query: { from, to } }),
    // Refetch keeps the frame: the charts hold the previous numbers while new ones load.
    placeholderData: (previous) => previous,
  });

/** Minutes as hours: "4.5 h", "12 h", "0 h". */
export function hoursText(minutes: number): string {
  const hours = minutes / 60;
  return `${hours >= 10 ? Math.round(hours) : Math.round(hours * 10) / 10} h`;
}

/** A clean top for an axis that holds `max`, and the ticks up to it (about four). */
export function niceScale(max: number, count = 4): { top: number; ticks: number[] } {
  if (max <= 0) return { top: 1, ticks: [0, 1] };
  const rough = max / count;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 2.5, 5, 10].find((f) => f * power >= rough) ?? 10) * power;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(Math.round(t * 1000) / 1000);
  return { top, ticks };
}

/** Five steps of a sequential scale (1..5) for a value, 0 for nothing at all. */
export function heatStep(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.min(5, Math.max(1, Math.ceil((value / max) * 5)));
}

export const BUCKET_LABELS: Record<DoneBucket, string> = {
  day: "< 1 day",
  "3days": "1–3 days",
  week: "3–7 days",
  "2weeks": "1–2 weeks",
  "4weeks": "2–4 weeks",
  longer: "> 4 weeks",
};

export const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export interface WeekdayStats {
  /** 0 = Monday ... 6 = Sunday. */
  weekday: number;
  /** How many of this weekday the period has, up to today. */
  days: number;
  /** Worked minutes on those days together. */
  minutes: number;
  /** Worked minutes on one of them, on average (0 without days). */
  average: number;
}

/**
 * Worked time per weekday (S5#4): the days of the period up to today, grouped by weekday, with their total
 * and the average for one such day. Days in the future are left out, so they do not pull the average down.
 */
export function weekdayStats(days: { date: string; workedMinutes: number }[], today: string): WeekdayStats[] {
  const rows = WEEKDAY_SHORT.map((_, weekday) => ({ weekday, days: 0, minutes: 0, average: 0 }));
  for (const day of days) {
    if (day.date > today) continue;
    const row = rows[isoWeekday(day.date) - 1] as WeekdayStats;
    row.days += 1;
    row.minutes += day.workedMinutes;
  }
  for (const row of rows) row.average = row.days > 0 ? row.minutes / row.days : 0;
  return rows;
}
