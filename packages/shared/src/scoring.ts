import { daysBetween, daysSince, toLocalDate } from "./dates.ts";
import type { NextMode, Reason } from "./entities.ts";
import { type Priority, priorityOf } from "./labels.ts";
import type { TodoStatus } from "./primitives.ts";

/** Points of the Next up score. */
export const SCORE = {
  priority: { critical: 40, high: 25, medium: 12, none: 8, low: 4 },
  overdueBase: 30,
  overduePerDay: 2,
  overdueCap: 50,
  dueToday: 28,
  /** [last day inclusive, points] for "due in N days". */
  dueSoon: [
    [3, 20],
    [7, 10],
    [14, 4],
  ],
  planned: 15,
  agePerDay: 0.4,
  ageCap: 20,
  /** The age chip shows from this many days on; the points count from day one. */
  ageChipFromDays: 7,
  idleFromDays: 14,
  idlePerDay: 0.5,
  idleCap: 15,
  inProgress: 10,
  /** Per active todo this one blocks, up to blocksCap. */
  blocksPer: 5,
  blocksCap: 15,
} as const;

/** The fields scoring needs; the full Todo fits. */
export interface ScorableTodo {
  id: number;
  status: TodoStatus;
  createdAt: string;
  lastActivityAt: string;
  dueOn: string | null;
  plannedOn: string | null;
  labels: readonly { name: string }[];
  /** Links to other todos; the full Todo fits. Leaving them out means no links. */
  links?: {
    blocks: readonly LinkedTodo[];
    blockedBy: readonly LinkedTodo[];
  };
}

export interface LinkedTodo {
  id: number;
  status: TodoStatus;
}

/** The blockers that are not done yet: while there is one, the todo waits. */
export function activeBlockers(todo: Pick<ScorableTodo, "links">): LinkedTodo[] {
  return (todo.links?.blockedBy ?? []).filter((t) => t.status !== "done");
}

/** "waiting on #12" (and more ids) for a todo with active blockers, else null. */
export function waitingReason(todo: Pick<ScorableTodo, "links">): Reason | null {
  const blockers = activeBlockers(todo);
  if (blockers.length === 0) return null;
  return { kind: "waiting", label: `waiting on ${blockers.map((t) => `#${t.id}`).join(", ")}`, points: 0 };
}

export interface ScoreContext {
  /** Local calendar date `YYYY-MM-DD` in `timeZone`. */
  today: string;
  timeZone: string;
}

export interface ScoreResult {
  score: number;
  /** The visible chips, highest points first. The score also counts points without a chip
   * (no priority label, age under 7 days). */
  reasons: Reason[];
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function scoreTodo(todo: ScorableTodo, ctx: ScoreContext): ScoreResult {
  const reasons: Reason[] = [];
  let score = 0;
  const add = (points: number, reason?: Omit<Reason, "points">): void => {
    const rounded = round1(points);
    score += rounded;
    if (reason && rounded > 0) reasons.push({ ...reason, points: rounded });
  };

  const priority = priorityOf(todo.labels);
  if (priority === null) add(SCORE.priority.none);
  else add(SCORE.priority[priority], { kind: "priority", label: `priority::${priority}` });

  if (todo.dueOn !== null) {
    const days = daysBetween(ctx.today, todo.dueOn);
    if (days < 0) {
      const overdue = -days;
      add(Math.min(SCORE.overdueCap, SCORE.overdueBase + SCORE.overduePerDay * overdue), {
        kind: "overdue",
        label: `overdue ${overdue}d`,
      });
    } else if (days === 0) {
      add(SCORE.dueToday, { kind: "due_today", label: "due today" });
    } else {
      const band = SCORE.dueSoon.find(([lastDay]) => days <= lastDay);
      if (band) add(band[1], { kind: "due_soon", label: `due in ${days}d` });
    }
  }

  if (todo.plannedOn !== null) {
    const ago = daysBetween(todo.plannedOn, ctx.today);
    if (ago >= 0) {
      add(SCORE.planned, { kind: "planned", label: ago === 0 ? "planned today" : `planned ${ago}d ago` });
    }
  }

  if (todo.status === "in_progress") add(SCORE.inProgress, { kind: "in_progress", label: "in progress" });

  const blocking = (todo.links?.blocks ?? []).filter((t) => t.status !== "done").length;
  if (blocking > 0) {
    add(Math.min(SCORE.blocksCap, SCORE.blocksPer * blocking), {
      kind: "blocks",
      label: `blocks ${blocking}`,
    });
  }

  const age = Math.max(0, daysSince(todo.createdAt, ctx.today, ctx.timeZone));
  const agePoints = Math.min(SCORE.ageCap, SCORE.agePerDay * age);
  add(agePoints, age >= SCORE.ageChipFromDays ? { kind: "age", label: `open ${age}d` } : undefined);

  const idle = Math.max(0, daysSince(todo.lastActivityAt, ctx.today, ctx.timeZone));
  if (idle >= SCORE.idleFromDays) {
    add(Math.min(SCORE.idleCap, SCORE.idlePerDay * (idle - SCORE.idleFromDays)), {
      kind: "idle",
      label: `untouched ${idle}d`,
    });
  }

  reasons.sort((a, b) => b.points - a.points);
  return { score: round1(score), reasons };
}

/** Sort position of a priority; no priority sits between medium and low. */
export const PRIORITY_ORDER: Record<Priority | "none", number> = {
  critical: 0,
  high: 1,
  medium: 2,
  none: 3,
  low: 4,
};

export function priorityRank(todo: Pick<ScorableTodo, "labels">): number {
  return PRIORITY_ORDER[priorityOf(todo.labels) ?? "none"];
}

interface Scored<T> {
  todo: T;
  score: number;
  reasons: Reason[];
}

const byCreated = (a: ScorableTodo, b: ScorableTodo): number =>
  Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id;

const byDue = (a: ScorableTodo, b: ScorableTodo): number => {
  if (a.dueOn === b.dueOn) return 0;
  if (a.dueOn === null) return 1;
  if (b.dueOn === null) return -1;
  return a.dueOn < b.dueOn ? -1 : 1;
};

const byPriority = (a: ScorableTodo, b: ScorableTodo): number => priorityRank(a) - priorityRank(b);

const ORDERS: Record<NextMode, <T extends ScorableTodo>(a: Scored<T>, b: Scored<T>) => number> = {
  smart: (a, b) => b.score - a.score || byCreated(a.todo, b.todo),
  oldest: (a, b) => byCreated(a.todo, b.todo),
  priority: (a, b) => byPriority(a.todo, b.todo) || byDue(a.todo, b.todo) || byCreated(a.todo, b.todo),
  due: (a, b) => byDue(a.todo, b.todo) || byPriority(a.todo, b.todo) || byCreated(a.todo, b.todo),
};

export interface RankOptions extends ScoreContext {
  mode: NextMode;
  /** Maximum number of ranked items; blocked todos are not limited. */
  limit?: number;
}

export interface Ranked<T> {
  items: Scored<T>[];
  /** Blocked todos and todos waiting on an active blocker, oldest first; they are not ranked. */
  blocked: T[];
}

/**
 * Ranks todos for Next up. Done todos are left out; blocked ones, and active todos with a blocker
 * that is not done (waitingReason), go to `blocked`.
 */
export function rankTodos<T extends ScorableTodo>(todos: readonly T[], options: RankOptions): Ranked<T> {
  const ctx: ScoreContext = { today: options.today, timeZone: options.timeZone };
  const scored: Scored<T>[] = [];
  const blocked: T[] = [];
  for (const todo of todos) {
    if (todo.status === "done") continue;
    if (todo.status === "blocked" || activeBlockers(todo).length > 0) blocked.push(todo);
    else scored.push({ todo, ...scoreTodo(todo, ctx) });
  }
  scored.sort(ORDERS[options.mode]);
  blocked.sort(byCreated);
  return { items: options.limit === undefined ? scored : scored.slice(0, options.limit), blocked };
}

export interface NextUpOptions {
  mode: NextMode;
  now: Date;
  timeZone: string;
  limit?: number;
}

/** The full Next up response body (for any todo shape that can be scored). */
export function buildNextUp<T extends ScorableTodo>(todos: readonly T[], options: NextUpOptions) {
  const today = toLocalDate(options.now, options.timeZone);
  const ranked = rankTodos(todos, {
    mode: options.mode,
    today,
    timeZone: options.timeZone,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
  return {
    mode: options.mode,
    today,
    generatedAt: options.now.toISOString(),
    items: ranked.items,
    blocked: ranked.blocked,
  };
}
