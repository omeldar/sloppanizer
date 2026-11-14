import {
  type ActivityItem,
  daysBetween,
  describeEvent,
  describeRecurrence,
  formatDuration,
  type Label,
  type NextUp,
  type Note,
  type NoteSummary,
  parseChecklist,
  type PeopleStats,
  type Person,
  type PersonBrief,
  type PersonStat,
  type PersonTag,
  type Project,
  type SearchHit,
  type SearchResult,
  type Stats,
  type Todo,
  type TodoRef,
  type Topic,
  toLocalDate,
  toLocalDateTime,
  waitingReason,
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

export const personName = (person: Pick<PersonBrief, "displayName">): string => person.displayName;

/**
 * One line per todo, e.g.
 * `#142 open | Renew SSL certs | priority::high, homelab | project homelab | due 2026-11-09 (overdue 2d) | open 41d | req: Anna Meier`
 * and, when they apply, `| 2/5 subtasks | checklist 3/7 | waiting on #12 | repeats every week`.
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
  if (todo.contacts.length > 0) parts.push(`contact: ${todo.contacts.map(personName).join(", ")}`);
  const { subtasks, checklist } = todo.progress;
  if (subtasks.total > 0) parts.push(`${subtasks.done}/${subtasks.total} subtasks`);
  if (checklist.total > 0) parts.push(`checklist ${checklist.done}/${checklist.total}`);
  const waiting = done ? null : waitingReason(todo);
  if (waiting) parts.push(waiting.label);
  if (todo.recurrence) parts.push(`repeats ${describeRecurrence(todo.recurrence)}`);
  return parts.join(" | ");
}

const refText = (ref: TodoRef): string => `#${ref.id} ${ref.title} (${ref.status})`;

export function todoLines(todos: readonly Todo[], ctx: DateContext, empty = "No todos match."): string {
  return todos.length === 0 ? empty : todos.map((todo) => todoLine(todo, ctx)).join("\n");
}

const local = (instant: string, ctx: DateContext): string =>
  `${toLocalDate(instant, ctx.timeZone)} (${ago(toLocalDate(instant, ctx.timeZone), ctx.today)})`;

const contactRef = (p: PersonBrief): string =>
  `${p.displayName} (person ${p.id}${p.team ? `, ${p.team}` : ""})`;

/** Everything about one todo (with its subtasks when given), the description last. */
export function todoDetail(todo: Todo, ctx: DateContext, subtasks: readonly Todo[] = []): string {
  const lines = [todoLine(todo, ctx)];
  if (todo.parent) lines.push(`Subtask of #${todo.parent.id} ${todo.parent.title}`);
  lines.push(`created ${local(todo.createdAt, ctx)}`);
  lines.push(`last activity ${local(todo.lastActivityAt, ctx)}`);
  if (todo.plannedOn) lines.push(`planned ${todo.plannedOn} (${ago(todo.plannedOn, ctx.today)})`);
  if (todo.requestedBy.length > 0) {
    lines.push(
      `requested by: ${todo.requestedBy.map((p) => `${p.displayName} (person ${p.id})`).join(", ")}`,
    );
  }
  if (todo.contacts.length > 0) {
    lines.push(`contacts: ${todo.contacts.map(contactRef).join(", ")}`);
  }
  if (todo.commentCount > 0) {
    lines.push(`comments: ${todo.commentCount} (get_activity shows the thread)`);
  }
  const { links } = todo;
  if (links.blockedBy.length > 0) lines.push(`blocked by: ${links.blockedBy.map(refText).join(", ")}`);
  if (links.blocks.length > 0) lines.push(`blocks: ${links.blocks.map(refText).join(", ")}`);
  if (links.relatesTo.length > 0) lines.push(`relates to: ${links.relatesTo.map(refText).join(", ")}`);
  if (todo.urls.length > 0) lines.push("web links:", urlLines(todo));
  if (todo.recurrence) {
    const next = todo.nextOccurrence ? ` (next: #${todo.nextOccurrence.id})` : "";
    lines.push(`Repeats ${describeRecurrence(todo.recurrence)}${next}`);
  }
  if (todo.previousOccurrenceId !== null) lines.push(`previous occurrence: #${todo.previousOccurrenceId}`);
  if (subtasks.length > 0) {
    const { done, total } = todo.progress.subtasks;
    lines.push("", `Subtasks (${done}/${total} done):`, ...subtasks.map((t) => `- ${todoLine(t, ctx)}`));
  }
  const items = parseChecklist(todo.descriptionMd);
  if (items.length > 0) {
    lines.push(
      "",
      "Checklist (check_item takes the number):",
      ...items.map((item) => `[${item.checked ? "x" : " "}] ${item.index} ${item.text}`),
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

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * One line per person, e.g.
 * `person 7 | Max Muster | Network team | topics: firewall rules, VPN | tags: fast reply | contact for 3 | note: Basel`.
 * Takes the brief form too (inside todos and 409 candidates); then only the parts it has.
 */
export function personLine(person: PersonBrief | Person): string {
  const parts = [`person ${person.id}`, person.displayName];
  if (person.team) parts.push(person.team);
  if ("topics" in person) {
    if (person.topics.length > 0) parts.push(`topics: ${person.topics.join(", ")}`);
    if (person.tags.length > 0) parts.push(`tags: ${person.tags.map((t) => t.name).join(", ")}`);
    const { requested, requestedOpen, contact, contactOpen } = person.counts;
    if (requested > 0) parts.push(`requested ${requested} (${requestedOpen} open)`);
    if (contact > 0) parts.push(`contact for ${contact} (${contactOpen} open)`);
  }
  if (person.note) parts.push(`note: ${person.note}`);
  return parts.join(" | ");
}

/** Everything about a person, then the open todos they asked for and the ones they are a contact for. */
export function personDetail(
  person: Person,
  todos: { requested: readonly Todo[]; contactFor: readonly Todo[] },
  ctx: DateContext,
): string {
  const { counts } = person;
  const lines = [`person ${person.id} | ${person.displayName}`];
  if (person.note) lines.push(`note: ${person.note}`);
  lines.push(`team: ${person.team || "(none)"}`);
  lines.push(`email: ${person.email || "(none)"}`);
  lines.push(`topics: ${person.topics.length > 0 ? person.topics.join(", ") : "(none)"}`);
  lines.push(`tags: ${person.tags.length > 0 ? person.tags.map((t) => t.name).join(", ") : "(none)"}`);
  lines.push(
    `requested ${counts.requested} (${counts.requestedOpen} open, ${counts.requestedDone} done), ` +
      `contact for ${counts.contact} (${counts.contactOpen} open)`,
  );
  lines.push(`created ${local(person.createdAt, ctx)}, updated ${local(person.updatedAt, ctx)}`);
  lines.push(
    "",
    `Open todos they requested (${todos.requested.length}):`,
    todoLines(todos.requested, ctx, "None."),
  );
  lines.push(
    "",
    `Open todos they are a contact for (${todos.contactFor.length}):`,
    todoLines(todos.contactFor, ctx, "None."),
  );
  lines.push("", "Notes:", person.notesMd.trim() === "" ? "(no notes)" : person.notesMd);
  return lines.join("\n");
}

/** `Anna Meier | Platform | requested 14, open 3, done 11, median took 2d 4h | contact 5` */
export function personStatLine(stat: PersonStat): string {
  const { person, requested, contact } = stat;
  const parts = [person.displayName];
  if (person.team) parts.push(person.team);
  const median =
    requested.medianDoneMs === null ? "" : `, median took ${formatDuration(requested.medianDoneMs)}`;
  parts.push(`requested ${requested.total}, open ${requested.open}, done ${requested.done}${median}`);
  parts.push(`contact ${contact.total}`);
  return parts.join(" | ");
}

/** The period and totals, then one line per person. */
export function peopleStatsText(stats: PeopleStats): string {
  const period =
    stats.from || stats.to ? ` created ${stats.from ?? "any time"} to ${stats.to ?? "today"}` : "";
  const { totals } = stats;
  const median = totals.medianDoneMs === null ? "" : `, median took ${formatDuration(totals.medianDoneMs)}`;
  const role = stats.role === "requester" ? "requesters" : "contacts";
  if (stats.items.length === 0) return `No ${role} in todos${period}.`;
  return [
    `People as ${role}, todos${period}: ${totals.todos} (${totals.open} open, ${totals.done} done${median}):`,
    ...stats.items.map(personStatLine),
  ].join("\n");
}

export function topicLine(topic: Topic): string {
  return `topic ${topic.id} | ${topic.name} | ${plural(topic.peopleCount, "person", "people")}`;
}

export function personTagLine(tag: PersonTag): string {
  const parts = [tag.name, tag.color, plural(tag.peopleCount, "person", "people")];
  if (tag.description) parts.push(tag.description);
  return parts.join(" | ");
}

/** Lines after the first are indented, so a multi-line text stays one visible block. */
const indentRest = (text: string): string => text.trim().replaceAll("\n", "\n  ");

/**
 * One line per thread item, oldest first, e.g. `2026-11-12 14:03 you: changed status from Open to Done`;
 * comments carry their text: `2026-11-12 14:05 planner commented (comment 12): Ordered the part.`
 */
export function activityLine(item: ActivityItem, timeZone: string): string {
  if (item.type === "event") {
    const { event } = item;
    return `${toLocalDateTime(event.createdAt, timeZone)} ${event.actor}: ${describeEvent(event)}`;
  }
  const { comment } = item;
  const edited = comment.editedAt ? ", edited" : "";
  return `${toLocalDateTime(comment.createdAt, timeZone)} ${comment.actor} commented (comment ${comment.id}${edited}): ${indentRest(comment.bodyMd)}`;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** `note 4 | Title | project homelab | pinned | updated 2026-11-12 | excerpt` */
export function noteLine(note: NoteSummary | Note, ctx: DateContext): string {
  const parts = [`note ${note.id}`, note.title, note.project ? `project ${note.project.slug}` : "no project"];
  if (note.pinnedAt) parts.push("pinned");
  parts.push(`updated ${toLocalDate(note.updatedAt, ctx.timeZone)}`);
  const excerpt = oneLine("excerpt" in note ? note.excerpt : "");
  if (excerpt) parts.push(excerpt);
  return parts.join(" | ");
}

/** A note with its Markdown body. */
export function noteDetail(note: Note, ctx: DateContext): string {
  return [
    noteLine(note, ctx),
    `created ${local(note.createdAt, ctx)} by ${note.createdBy}`,
    "",
    note.bodyMd.trim() === "" ? "(empty)" : note.bodyMd,
  ].join("\n");
}

/** The snippet with the matched ranges in **bold** (ranges clamped to the snippet; overlapping or touching ones merged). */
export function highlight(snippet: string, ranges: readonly (readonly [number, number])[]): string {
  const merged: [number, number][] = [];
  const sorted = ranges
    .map(([start, end]): [number, number] => [Math.max(0, start), Math.min(snippet.length, end)])
    .filter(([start, end]) => end > start)
    .toSorted((a, b) => a[0] - b[0]);
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  let text = "";
  let at = 0;
  for (const [start, end] of merged) {
    text += `${snippet.slice(at, start)}**${snippet.slice(start, end)}**`;
    at = end;
  }
  return oneLine(text + snippet.slice(at));
}

export function searchHitLine(hit: SearchHit): string {
  const snippet = highlight(hit.snippet, hit.highlights);
  const parts: string[] = [];
  switch (hit.kind) {
    case "todo":
      parts.push(`#${hit.id}${hit.status ? ` ${hit.status}` : ""}`, hit.title);
      break;
    case "note":
      parts.push(`note ${hit.id}`, hit.title);
      break;
    case "comment":
      parts.push(`comment ${hit.id} on #${hit.todoId ?? "?"}`);
      break;
    case "person":
      parts.push(`person ${hit.id}`, hit.title);
      break;
  }
  if (hit.subtitle) parts.push(hit.subtitle);
  // A snippet that only repeats the title adds nothing.
  if (snippet && oneLine(hit.snippet) !== oneLine(hit.title)) parts.push(snippet);
  return parts.join(" | ");
}

const KIND_HEADINGS = { todo: "Todos", note: "Notes", comment: "Comments", person: "People" } as const;

/** Hits grouped by kind with the total per kind (the totals ignore the limit). */
export function searchText(result: SearchResult): string {
  const { counts } = result;
  const total = counts.todo + counts.note + counts.comment + counts.person;
  if (total === 0) return `Nothing found for "${result.q}".`;
  const lines = [
    `Found for "${result.q}": ${plural(counts.todo, "todo")}, ${plural(counts.note, "note")}, ` +
      `${plural(counts.comment, "comment")}, ${plural(counts.person, "person", "people")}.`,
  ];
  for (const kind of ["todo", "note", "comment", "person"] as const) {
    const hits = result.items.filter((hit) => hit.kind === kind);
    if (hits.length === 0) continue;
    const more = counts[kind] > hits.length ? ` (showing ${hits.length} of ${counts[kind]})` : "";
    lines.push("", `${KIND_HEADINGS[kind]}${more}:`, ...hits.map(searchHitLine));
  }
  return lines.join("\n");
}

export function statsLine(stats: Stats, ctx: DateContext): string {
  const exported = stats.lastExportAt ? `last export ${local(stats.lastExportAt, ctx)}` : "never exported";
  return (
    `open ${stats.open}, in progress ${stats.inProgress}, blocked ${stats.blocked}, overdue ${stats.overdue}, ` +
    `due today ${stats.dueToday}, planned today ${stats.plannedToday}, inbox ${stats.inbox}, ` +
    `done last 7 days ${stats.doneLast7Days}; ${exported}`
  );
}

/** A todo's web links, one per line with the id remove_web_link takes. */
export function urlLines(todo: Todo): string {
  if (todo.urls.length === 0) return "No web links.";
  return todo.urls.map((u) => `- link ${u.id}: ${u.label ? `${u.label} ` : ""}<${u.url}>`).join("\n");
}
