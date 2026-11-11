import {
  daysBetween,
  formatDuration,
  type Label,
  type NextUp,
  type Person,
  type Project,
  type Stats,
  type Todo,
  toLocalDate,
} from "@organizer/shared";

/** What "today" means for relative dates. */
export interface DateContext {
  today: string;
  timeZone: string;
}

export function dateContext(now: Date, timeZone: string): DateContext {
  return { today: toLocalDate(now, timeZone), timeZone };
}

function relativeDue(dueOn: string, today: string): string {
  const days = daysBetween(today, dueOn);
  if (days < 0) return `overdue ${-days}d`;
  if (days === 0) return "today";
  return `in ${days}d`;
}

function ago(date: string, today: string): string {
  const days = daysBetween(date, today);
  if (days === 0) return "today";
  return days > 0 ? `${days}d ago` : `in ${-days}d`;
}

export const personName = (person: Pick<Person, "displayName">): string => person.displayName;

/**
 * One line per todo, e.g.
 * `#142 open | Renew SSL certs | priority::high, homelab | project homelab | due 2026-11-09 (overdue 2d) | open 41d | req: Anna Meier`
 */
export function todoLine(todo: Todo, ctx: DateContext): string {
  const parts = [`#${todo.id} ${todo.status}`, todo.title];
  if (todo.labels.length > 0) parts.push(todo.labels.map((label) => label.name).join(", "));
  parts.push(todo.project ? `project ${todo.project.slug}` : "inbox");
  const done = todo.status === "done";
  if (todo.dueOn)
    parts.push(done ? `due ${todo.dueOn}` : `due ${todo.dueOn} (${relativeDue(todo.dueOn, ctx.today)})`);
  if (todo.plannedOn && !done) parts.push(`planned ${todo.plannedOn}`);
  if (done && todo.doneAt) {
    const took = todo.durationMs === null ? "" : `, took ${formatDuration(todo.durationMs)}`;
    parts.push(`done ${toLocalDate(todo.doneAt, ctx.timeZone)}${took}`);
  } else {
    parts.push(`open ${Math.max(0, daysBetween(toLocalDate(todo.createdAt, ctx.timeZone), ctx.today))}d`);
  }
  if (todo.requestedBy.length > 0) parts.push(`req: ${todo.requestedBy.map(personName).join(", ")}`);
  return parts.join(" | ");
}

export function todoLines(todos: readonly Todo[], ctx: DateContext, empty = "No todos match."): string {
  return todos.length === 0 ? empty : todos.map((todo) => todoLine(todo, ctx)).join("\n");
}

const local = (instant: string, ctx: DateContext): string =>
  `${toLocalDate(instant, ctx.timeZone)} (${ago(toLocalDate(instant, ctx.timeZone), ctx.today)})`;

/** Everything about one todo, the description last. */
export function todoDetail(todo: Todo, ctx: DateContext): string {
  const lines = [todoLine(todo, ctx), `created ${local(todo.createdAt, ctx)}`];
  lines.push(`last activity ${local(todo.lastActivityAt, ctx)}`);
  if (todo.plannedOn) lines.push(`planned ${todo.plannedOn} (${ago(todo.plannedOn, ctx.today)})`);
  if (todo.requestedBy.length > 0) {
    lines.push(
      `requested by: ${todo.requestedBy.map((p) => `${p.displayName} (person ${p.id})`).join(", ")}`,
    );
  }
  lines.push("", todo.descriptionMd.trim() === "" ? "(no description)" : todo.descriptionMd);
  return lines.join("\n");
}

export function nextUpText(next: NextUp, timeZone: string): string {
  const ctx = { today: next.today, timeZone };
  const lines = [`Next up (${next.mode}), today ${next.today}:`];
  if (next.items.length === 0) lines.push("Nothing open. Add todos with create_todo.");
  next.items.forEach((item, index) => {
    const why = item.reasons.map((reason) => reason.label).join(", ");
    lines.push(
      `${index + 1}. ${todoLine(item.todo, ctx)} | score ${item.score}${why ? ` | why: ${why}` : ""}`,
    );
  });
  if (next.blocked.length > 0) {
    lines.push("", `Blocked (${next.blocked.length}):`, todoLines(next.blocked, ctx));
  }
  return lines.join("\n");
}

export function projectLine(project: Project): string {
  const parts = [`id ${project.id}`, project.slug, project.name, `${project.openCount} open`];
  if (project.archivedAt) parts.push("archived");
  if (project.description) parts.push(project.description);
  return parts.join(" | ");
}

export function labelLine(label: Label): string {
  const parts = [label.name, label.color];
  if (label.rank !== null) parts.push(`rank ${label.rank}`);
  if (label.description) parts.push(label.description);
  return parts.join(" | ");
}

export function personLine(person: Person): string {
  return [`person ${person.id}`, person.displayName, ...(person.note ? [person.note] : [])].join(" | ");
}

export function statsLine(stats: Stats, ctx: DateContext): string {
  const exported = stats.lastExportAt ? `last export ${local(stats.lastExportAt, ctx)}` : "never exported";
  return (
    `open ${stats.open}, in progress ${stats.inProgress}, blocked ${stats.blocked}, overdue ${stats.overdue}, ` +
    `due today ${stats.dueToday}, planned today ${stats.plannedToday}, inbox ${stats.inbox}, ` +
    `done last 7 days ${stats.doneLast7Days}; ${exported}`
  );
}
