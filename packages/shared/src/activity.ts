import { formatDate } from "./dates.ts";
import type { ActivityEvent } from "./entities.ts";
import { STATUS_LABELS, TODO_STATUSES, type TodoStatus } from "./primitives.ts";
import { describeRecurrence, RecurrenceRule } from "./recurrence.ts";

interface PersonSummary {
  id: number;
  name: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

const personList = (value: unknown): PersonSummary[] =>
  Array.isArray(value)
    ? value.filter(
        (v): v is PersonSummary => isRecord(v) && typeof v.id === "number" && typeof v.name === "string",
      )
    : [];

const lowerSet = (names: readonly string[]): Set<string> => new Set(names.map((n) => n.toLowerCase()));

/** "A", "A and B", "A, B and C". */
function joinWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function statusName(value: unknown): string {
  return typeof value === "string" && (TODO_STATUSES as readonly string[]).includes(value)
    ? STATUS_LABELS[value as TodoStatus]
    : String(value);
}

/** "added label a and removed labels b and c". */
function addedRemoved(noun: string, added: readonly string[], removed: readonly string[]): string {
  const part = (verb: string, names: readonly string[]) =>
    `${verb} ${noun}${names.length > 1 ? "s" : ""} ${joinWords(names)}`;
  const parts: string[] = [];
  if (added.length > 0) parts.push(part("added", added));
  if (removed.length > 0) parts.push(part("removed", removed));
  return parts.length > 0 ? parts.join(" and ") : `changed the ${noun}s`;
}

function describeProject(to: unknown): string {
  if (to === null || to === undefined) return "moved to the Inbox";
  if (isRecord(to)) {
    return typeof to.name === "string"
      ? `moved to project ${to.name}`
      : "moved to a project that was deleted";
  }
  return `moved to project ${String(to)}`;
}

function describeDates(from: Record<string, unknown>, to: Record<string, unknown>): string {
  const parts: string[] = [];
  if (from.plannedOn !== to.plannedOn) {
    parts.push(
      typeof to.plannedOn === "string" ? `planned for ${formatDate(to.plannedOn)}` : "removed the plan date",
    );
  }
  if (from.dueOn !== to.dueOn) {
    parts.push(
      typeof to.dueOn === "string" ? `set the due date to ${formatDate(to.dueOn)}` : "removed the due date",
    );
  }
  return parts.length > 0 ? parts.join(" and ") : "changed the dates";
}

interface TodoSummary {
  id: number;
}

const todoRef = (value: unknown): TodoSummary | null =>
  isRecord(value) && typeof value.id === "number" ? { id: value.id } : null;

const todoList = (value: unknown): TodoSummary[] =>
  Array.isArray(value) ? value.map(todoRef).filter((t): t is TodoSummary => t !== null) : [];

const ids = (list: readonly TodoSummary[]): string[] => list.map((t) => `#${t.id}`);

function describeParent(from: unknown, to: unknown): string {
  const next = todoRef(to);
  if (next) return `made this a subtask of #${next.id}`;
  const previous = todoRef(from);
  return previous ? `moved out of #${previous.id}` : "changed the parent";
}

const LINK_WORDS: Record<string, string> = {
  blocks: "blocks",
  blocked_by: "blocked by",
  relates: "relates to",
};

/** "linked: blocks #12", "removed link: blocks #12 and #13". */
function describeLinks(kind: unknown, added: TodoSummary[], removed: TodoSummary[]): string {
  const words = LINK_WORDS[String(kind)] ?? "relates to";
  const parts: string[] = [];
  if (added.length > 0) parts.push(`linked: ${words} ${joinWords(ids(added))}`);
  if (removed.length > 0) parts.push(`removed link: ${words} ${joinWords(ids(removed))}`);
  return parts.length > 0 ? parts.join(" and ") : "changed the links";
}

function ruleText(value: unknown): string | null {
  const rule = RecurrenceRule.safeParse(value);
  return rule.success ? describeRecurrence(rule.data) : null;
}

function describeRecurrenceChange(from: unknown, to: unknown): string {
  if (to === null || to === undefined) return "stopped repeating";
  const text = ruleText(to);
  if (text === null) return "changed the repeat";
  return from === null || from === undefined ? `set it to repeat ${text}` : `changed the repeat to ${text}`;
}

function describeRecurred(next: unknown): string {
  if (!isRecord(next) || typeof next.id !== "number") return "created the next one";
  const date = typeof next.dueOn === "string" ? next.dueOn : next.plannedOn;
  return typeof date === "string"
    ? `created the next one, #${next.id}, for ${formatDate(date)}`
    : `created the next one, #${next.id}`;
}

const assigneeName = (value: unknown): string | null =>
  isRecord(value) && typeof value.name === "string" ? value.name : null;

function describeAssignee(from: unknown, to: unknown): string {
  const next = assigneeName(to);
  if (next) return `assigned it to ${next}`;
  const previous = assigneeName(from);
  return previous ? `removed ${previous} as assignee` : "removed the assignee";
}

function describeActionNeeded(from: unknown, to: unknown): string {
  if (typeof to === "string") {
    const reason = to.trim() === "" ? "" : `: ${to}`;
    return typeof from === "string"
      ? `changed the action needed${reason}`
      : `marked it action needed${reason}`;
  }
  return "removed the action needed marker";
}

/**
 * One plain sentence for a history event, without the actor: "changed status from Open to Done",
 * "added contact Max Muster", "edited the description". `people` maps person ids to their current
 * names; without it the names stored in the event are used.
 */
export function describeEvent(event: ActivityEvent, people?: ReadonlyMap<number, string>): string {
  const data = event.data;
  const name = (p: PersonSummary) => people?.get(p.id) ?? p.name;
  switch (event.kind) {
    case "created":
      return "created the todo";
    case "title_changed":
      return `renamed from "${String(data.from)}" to "${String(data.to)}"`;
    case "description_changed":
      return "edited the description";
    case "status_changed":
      return `changed status from ${statusName(data.from)} to ${statusName(data.to)}`;
    case "labels_changed": {
      const from = strings(data.from);
      const to = strings(data.to);
      const before = lowerSet(from);
      const after = lowerSet(to);
      return addedRemoved(
        "label",
        to.filter((n) => !before.has(n.toLowerCase())),
        from.filter((n) => !after.has(n.toLowerCase())),
      );
    }
    case "people_changed": {
      const role = data.role === "contact" ? "contact" : "requester";
      const from = personList(data.from);
      const to = personList(data.to);
      const fromIds = new Set(from.map((p) => p.id));
      const toIds = new Set(to.map((p) => p.id));
      return addedRemoved(
        role,
        to.filter((p) => !fromIds.has(p.id)).map(name),
        from.filter((p) => !toIds.has(p.id)).map(name),
      );
    }
    case "project_changed":
      return describeProject(data.to);
    case "dates_changed":
      return describeDates(isRecord(data.from) ? data.from : {}, isRecord(data.to) ? data.to : {});
    case "parent_changed":
      return describeParent(data.from, data.to);
    case "subtasks_changed":
      return addedRemoved("subtask", ids(todoList(data.added)), ids(todoList(data.removed)));
    case "links_changed":
      return describeLinks(data.kind, todoList(data.added), todoList(data.removed));
    case "checklist_changed":
      return `${data.checked === true ? "checked" : "unchecked"} "${String(data.text ?? "")}"`;
    case "recurrence_changed":
      return describeRecurrenceChange(data.from, data.to);
    case "recurred":
      return describeRecurred(data.next);
    case "assignee_changed":
      return describeAssignee(data.from, data.to);
    case "action_needed_changed":
      return describeActionNeeded(data.from, data.to);
  }
}
