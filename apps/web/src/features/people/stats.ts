import { addDays, formatDuration, type PEOPLE_STATS_SORTS, type PersonStat } from "@organizer/shared";
import type { PeopleStatsParams } from "../../lib/queries.ts";
import { splitList } from "./filters.tsx";

export const PERIODS = {
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  "12m": "Last 12 months",
  all: "All time",
  custom: "Custom",
} as const;
export type Period = keyof typeof PERIODS;
export const DEFAULT_PERIOD: Period = "12m";

export type StatsSort = (typeof PEOPLE_STATS_SORTS)[number];

/** URL search of /people/stats; lists are comma text like on the directory. */
export interface StatsSearch {
  period?: Period;
  /** Only with period "custom". */
  from?: string;
  to?: string;
  role?: "requester" | "contact";
  topic?: string;
  tag?: string;
  team?: string;
  label?: string;
  /** Project slug or "inbox". */
  project?: string;
  sort?: StatsSort;
}

/** Inclusive created-date range of a period, ending today. */
export function periodRange(search: StatsSearch, today: string): { from?: string; to?: string } {
  const period = search.period ?? DEFAULT_PERIOD;
  if (period === "30d") return { from: addDays(today, -29), to: today };
  if (period === "90d") return { from: addDays(today, -89), to: today };
  if (period === "12m") {
    const [year, month, day] = today.split("-").map(Number) as [number, number, number];
    const lastYear = new Date(Date.UTC(year - 1, month - 1, day)).toISOString().slice(0, 10);
    return { from: addDays(lastYear, 1), to: today };
  }
  if (period === "custom") return { from: search.from || undefined, to: search.to || undefined };
  return {};
}

/** URL search -> API query. The project slug needs the project list; undefined while it loads. */
export function peopleStatsParams(
  search: StatsSearch,
  today: string,
  projectIdOf: (slug: string) => number | undefined,
): PeopleStatsParams | undefined {
  let projectId: number | "inbox" | undefined;
  if (search.project === "inbox") projectId = "inbox";
  else if (search.project) {
    projectId = projectIdOf(search.project);
    if (projectId === undefined) return undefined;
  }
  return {
    ...periodRange(search, today),
    role: search.role ?? "requester",
    topic: splitList(search.topic),
    tag: splitList(search.tag),
    team: search.team,
    label: search.label ? [search.label] : [],
    projectId,
    sort: search.sort ?? "total",
    limit: 500,
  };
}

/** The numbers a row shows for the chosen role. */
export function roleNumbers(stat: PersonStat, role: "requester" | "contact") {
  return role === "requester" ? stat.requested : stat.contact;
}

/** Widths in percent of the open and done parts of a row's bar, scaled to the biggest total listed. */
export function barParts(
  numbers: { total: number; open: number; done: number },
  maxTotal: number,
): { open: number; done: number } {
  if (maxTotal <= 0) return { open: 0, done: 0 };
  return { open: (numbers.open / maxTotal) * 100, done: (numbers.done / maxTotal) * 100 };
}

export const tookText = (ms: number | null): string => (ms === null ? "-" : formatDuration(ms));
export const daysText = (days: number | null): string => (days === null ? "-" : `${days}d`);
