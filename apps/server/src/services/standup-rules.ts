import type { StandupKind, TodoStatus } from "@organizer/shared";

/**
 * The rules of the standup list in one place, pure, so each rule has its own test. A todo is looked at
 * per standup with its cutoff: the later of the standup's window start and its newest mark there.
 *
 * - done: done after the cutoff (later comments do not bring it back).
 * - blocked: an update or comment after the cutoff. A blocked todo this standup never marked is
 *   always on the list, also without changes, until it is said or dismissed (like in progress).
 * - in progress: "started" when it moved to in progress after the cutoff, else "updated" when it has
 *   an update or comment after it. A todo in progress this standup never marked is always on the list
 *   (the first standup shows everything in progress), as "started" when nothing else is new.
 * - open todos never are.
 */

export interface RuleTodo {
  status: TodoStatus;
  doneAt: string | null;
  lastActivityAt: string;
  /** The newest move into its current status, at any time, or null when the history has none. */
  statusSince: string | null;
}

/** An update event (STANDUP_UPDATE_KINDS) or a comment of the todo. */
export interface RuleActivity {
  createdAt: string;
  /** A status change into in progress. */
  start?: boolean;
}

export interface Classified {
  kind: StandupKind;
  /** The newest activity that put it on the list. */
  at: string;
}

/**
 * Whether the todo can be an item at all, from its row alone (no history read). classify() never
 * returns an item when this is false, so the list reads history only for these todos.
 */
export function mayBeItem(
  todo: Pick<RuleTodo, "status" | "doneAt" | "lastActivityAt">,
  cutoff: string,
  marked: boolean,
): boolean {
  if (todo.status === "done") return todo.doneAt !== null && todo.doneAt > cutoff;
  if (todo.status === "open") return false;
  return !marked || todo.lastActivityAt > cutoff;
}

const atRest = (todo: RuleTodo): string => todo.statusSince ?? todo.lastActivityAt;

/**
 * The item a todo makes on a standup list, or null. `activity` is every update and comment of the
 * todo, in any order; only the ones after the cutoff count.
 */
export function classify(
  todo: RuleTodo,
  activity: readonly RuleActivity[],
  cutoff: string,
  marked: boolean,
): Classified | null {
  if (!mayBeItem(todo, cutoff, marked)) return null;
  if (todo.status === "done") return { kind: "done", at: todo.doneAt as string };
  const fresh = activity.filter((a) => a.createdAt > cutoff);
  const newest = fresh.reduce((max, a) => (a.createdAt > max ? a.createdAt : max), "");
  if (todo.status === "blocked") {
    if (newest !== "") return { kind: "blocked", at: newest };
    return marked ? null : { kind: "blocked", at: atRest(todo) };
  }
  if (fresh.some((a) => a.start === true)) return { kind: "started", at: newest };
  if (newest !== "") return { kind: "updated", at: newest };
  return marked ? null : { kind: "started", at: atRest(todo) };
}
