import {
  type StatsGroup,
  type BlockOccurrence,
  type RecurringTodo,
  type ActivityItem,
  daysBetween,
  describeEvent,
  describeRecurrence,
  formatDate,
  formatDateTime,
  formatDuration,
  type Label,
  languageNames,
  type Meeting,
  type MeetingOccurrence,
  type MeetingTodos,
  type NextUp,
  type Note,
  type NoteSummary,
  type NotificationList,
  parseChecklist,
  type PeopleStats,
  type Person,
  type PersonBrief,
  type PersonStat,
  type PersonTag,
  type Project,
  type SearchHit,
  type Space,
  type SearchResult,
  type Standup,
  type StandupItem,
  type StandupKind,
  type Stats,
  type Todo,
  type TodoRef,
  type Topic,
  toLocalDate,
  toLocalTime,
  waitingReason,
} from "@organizer/shared";

/**
 * A shared project as the tools name it. Its todos are numbered on their own, so the tools write them as
 * S<project id>#<todo id> ("S7#12"); #12 alone is always one of the account's own todos.
 */
export interface SharedRef {
  id: number;
  name: string;
}

export const sharedTodoRef = (spaceId: number, todoId: number): string => `S${spaceId}#${todoId}`;

/** "#12" for an own todo, "S7#12" for one in shared project 7. */
export const todoRefText = (id: number, space?: SharedRef): string =>
  space ? sharedTodoRef(space.id, id) : `#${id}`;

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
 * `#142 open | Renew SSL certs | priority::high, homelab | project homelab | due 09.11.2026 (overdue 2d) | open 41d | req: Anna Meier`
 * and, when they apply, `| 2/5 subtasks | checklist 3/7 | waiting on #12 | repeats every week`.
 */
export function todoLine(todo: Todo, ctx: DateContext, space?: SharedRef): string {
  const parts = [`${todoRefText(todo.id, space)} ${todo.status}`, todo.title];
  if (todo.actionNeeded)
    parts.push(`ACTION NEEDED${todo.actionNeeded.reason ? `: ${todo.actionNeeded.reason}` : ""}`);
  if (todo.labels.length > 0) parts.push(todo.labels.map((label) => label.name).join(", "));
  if (space) {
    // The project inside a shared project is named like it; only another one is worth naming.
    const inner = todo.project && todo.project.name !== space.name ? ` / ${todo.project.slug}` : "";
    parts.push(`shared ${space.name}${inner}`);
  } else {
    parts.push(todo.project ? `project ${todo.project.slug}` : "inbox");
  }
  if (todo.assignee) parts.push(`assigned to ${todo.assignee.name}`);
  else if (space) parts.push("unassigned");
  const done = todo.status === "done";
  if (todo.dueOn)
    parts.push(
      done
        ? `due ${formatDate(todo.dueOn)}`
        : `due ${formatDate(todo.dueOn)} (${relativeDue(todo.dueOn, ctx.today)})`,
    );
  if (todo.plannedOn && !done) parts.push(`planned ${formatDate(todo.plannedOn)}`);
  if (done && todo.doneAt) {
    const took = todo.durationMs === null ? "" : `, took ${formatDuration(todo.durationMs)}`;
    parts.push(`done ${formatDate(toLocalDate(todo.doneAt, ctx.timeZone))}${took}`);
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

const refText = (ref: TodoRef, space?: SharedRef): string =>
  `${todoRefText(ref.id, space)} ${ref.title} (${ref.status})`;

export function todoLines(
  todos: readonly Todo[],
  ctx: DateContext,
  empty = "No todos match.",
  space?: SharedRef,
): string {
  return todos.length === 0 ? empty : todos.map((todo) => todoLine(todo, ctx, space)).join("\n");
}

const local = (instant: string, ctx: DateContext): string => {
  const date = toLocalDate(instant, ctx.timeZone);
  return `${formatDate(date)} (${ago(date, ctx.today)})`;
};

const contactRef = (p: PersonBrief): string =>
  `${p.displayName} (person ${p.id}${p.team ? `, ${p.team}` : ""})`;

/** Everything about one todo (with its subtasks when given), the description last. */
export function todoDetail(
  todo: Todo,
  ctx: DateContext,
  subtasks: readonly Todo[] = [],
  space?: SharedRef,
): string {
  const ref = (id: number) => todoRefText(id, space);
  const lines = [todoLine(todo, ctx, space)];
  if (space) {
    lines.push(
      `In shared project ${space.name} (S${space.id}); its todos are S${space.id}#<id>.` +
        (todo.assignee
          ? ` Assigned to ${todo.assignee.name} (${todo.assignee.username}).`
          : " Not assigned."),
    );
  }
  if (todo.actionNeeded)
    lines.push(
      `ACTION NEEDED (set by ${todo.actionNeeded.by} on ${formatDate(toLocalDate(todo.actionNeeded.at, ctx.timeZone))})` +
        (todo.actionNeeded.reason ? `: ${todo.actionNeeded.reason}` : ""),
    );
  if (todo.parent) lines.push(`Subtask of ${ref(todo.parent.id)} ${todo.parent.title}`);
  lines.push(`created ${local(todo.createdAt, ctx)}`);
  lines.push(`last activity ${local(todo.lastActivityAt, ctx)}`);
  if (todo.plannedOn) lines.push(`planned ${formatDate(todo.plannedOn)} (${ago(todo.plannedOn, ctx.today)})`);
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
  const refs = (list: readonly TodoRef[]) => list.map((r) => refText(r, space)).join(", ");
  if (links.blockedBy.length > 0) lines.push(`blocked by: ${refs(links.blockedBy)}`);
  if (links.blocks.length > 0) lines.push(`blocks: ${refs(links.blocks)}`);
  if (links.relatesTo.length > 0) lines.push(`relates to: ${refs(links.relatesTo)}`);
  if (todo.urls.length > 0) lines.push("web links:", urlLines(todo));
  if (todo.recurrence) {
    const next = todo.nextOccurrence ? ` (next: ${ref(todo.nextOccurrence.id)})` : "";
    lines.push(`Repeats ${describeRecurrence(todo.recurrence)}${next}`);
  }
  if (todo.previousOccurrenceId !== null)
    lines.push(`previous occurrence: ${ref(todo.previousOccurrenceId)}`);
  if (subtasks.length > 0) {
    const { done, total } = todo.progress.subtasks;
    lines.push(
      "",
      `Subtasks (${done}/${total} done):`,
      ...subtasks.map((t) => `- ${todoLine(t, ctx, space)}`),
    );
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

/** Next up of a shared project, as next_up adds it to the account's own ranking. */
export interface SharedNextUp {
  space: SharedRef;
  next: NextUp;
}

/**
 * The ranking, with todos from shared projects (S7#12) ranked in by the same score: everything is
 * scored by one function on the same day, so the scores compare.
 */
export function nextUpText(
  next: NextUp,
  timeZone: string,
  shared: readonly SharedNextUp[] = [],
  limit = next.items.length,
): string {
  const ctx = { today: next.today, timeZone };
  const ranked = [
    ...next.items.map((item) => ({ item, space: undefined as SharedRef | undefined })),
    ...shared.flatMap((s) => s.next.items.map((item) => ({ item, space: s.space as SharedRef | undefined }))),
  ]
    .toSorted((a, b) => b.item.score - a.item.score)
    .slice(0, limit);
  const lines = [`Next up (${next.mode}), today ${formatDate(next.today)}:`];
  if (ranked.length === 0) lines.push("Nothing open. Add todos with create_todo.");
  ranked.forEach(({ item, space }, index) => {
    const why = item.reasons.map((reason) => reason.label).join(", ");
    lines.push(
      `${index + 1}. ${todoLine(item.todo, ctx, space)} | score ${item.score}${why ? ` | why: ${why}` : ""}`,
    );
  });
  const blocked = [
    ...next.blocked.map((todo) => todoLine(todo, ctx)),
    ...shared.flatMap((s) => s.next.blocked.map((todo) => todoLine(todo, ctx, s.space))),
  ];
  if (blocked.length > 0) lines.push("", `Blocked (${blocked.length}):`, ...blocked);
  return lines.join("\n");
}

/** "S7 Home move | 5 open | you: owner | members: anna (Anna Berg, owner), bobo". */
export function sharedProjectLine(space: Space): string {
  const members = space.members.map((m) => {
    const notes = [...(m.name === m.username ? [] : [m.name]), ...(m.role === "owner" ? ["owner"] : [])];
    return notes.length > 0 ? `${m.username} (${notes.join(", ")})` : m.username;
  });
  return [
    `S${space.id} ${space.name}`,
    `${space.openCount} open`,
    `you: ${space.role}`,
    `members: ${members.join(", ")}`,
  ].join(" | ");
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
 * `person 7 | Max Muster | Network team | languages: German | topics: firewall rules, VPN | tags: fast reply |
 * contact for 3 | note: Basel`.
 * Takes the brief form too (inside todos and 409 candidates); then only the parts it has.
 */
export function personLine(person: PersonBrief | Person): string {
  const parts = [`person ${person.id}`, person.displayName];
  if (person.team) parts.push(person.team);
  if ("topics" in person) {
    if (person.languages.length > 0) parts.push(`languages: ${languageNames(person.languages).join(", ")}`);
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
  lines.push(
    `languages: ${person.languages.length > 0 ? languageNames(person.languages).join(", ") : "(not set)"}`,
  );
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
    stats.from || stats.to
      ? ` created ${stats.from ? formatDate(stats.from) : "any time"} to ${stats.to ? formatDate(stats.to) : "today"}`
      : "";
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
 * One line per thread item, oldest first, e.g. `12.11.2026 14:03 you: changed status from Open to Done`;
 * comments carry their text: `12.11.2026 14:05 planner commented (comment 12): Ordered the part.`
 */
export function activityLine(item: ActivityItem, timeZone: string): string {
  if (item.type === "event") {
    const { event } = item;
    return `${formatDateTime(event.createdAt, timeZone)} ${event.actor}: ${describeEvent(event)}`;
  }
  const { comment } = item;
  const edited = comment.editedAt ? ", edited" : "";
  return `${formatDateTime(comment.createdAt, timeZone)} ${comment.actor} commented (comment ${comment.id}${edited}): ${indentRest(comment.bodyMd)}`;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** `note 4 | Title | project homelab | pinned | updated 12.11.2026 | excerpt` */
export function noteLine(note: NoteSummary | Note, ctx: DateContext): string {
  const parts = [`note ${note.id}`, note.title, note.project ? `project ${note.project.slug}` : "no project"];
  if (note.pinnedAt) parts.push("pinned");
  parts.push(`updated ${formatDate(toLocalDate(note.updatedAt, ctx.timeZone))}`);
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

export function searchHitLine(hit: SearchHit, space?: SharedRef): string {
  const snippet = highlight(hit.snippet, hit.highlights);
  const parts: string[] = [];
  switch (hit.kind) {
    case "todo":
      parts.push(`${todoRefText(hit.id, space)}${hit.status ? ` ${hit.status}` : ""}`, hit.title);
      break;
    case "note":
      parts.push(`note ${hit.id}`, hit.title);
      break;
    case "comment":
      parts.push(`comment ${hit.id} on ${hit.todoId === null ? "?" : todoRefText(hit.todoId, space)}`);
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

/** Hits in a shared project (todos and comments only), as search adds them under the own hits. */
export interface SharedSearch {
  space: SharedRef;
  result: SearchResult;
}

/** The hits of shared projects, one block per project with hits. */
export function sharedSearchText(shared: readonly SharedSearch[]): string {
  const lines: string[] = [];
  for (const { space, result } of shared) {
    if (result.items.length === 0) continue;
    const total = result.counts.todo + result.counts.comment;
    const more = total > result.items.length ? ` (showing ${result.items.length} of ${total})` : "";
    lines.push("", `In shared project ${space.name} (S${space.id})${more}:`);
    lines.push(...result.items.map((hit) => searchHitLine(hit, space)));
  }
  return lines.join("\n");
}

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
    lines.push("", `${KIND_HEADINGS[kind]}${more}:`, ...hits.map((hit) => searchHitLine(hit)));
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

// ---------- meetings ----------

/** `meeting 2 | Weekly Standup | standup | every week on Thu, 09:00–09:15 | next 19.11.2026 09:00 | 4 to say` */
export function meetingLine(meeting: Meeting, timeZone: string): string {
  const next = meeting.next
    ? `next ${formatDateTime(meeting.next.startAt, timeZone)}${meeting.next.status === "moved" ? " (moved)" : ""}`
    : "no next date";
  const parts = [`meeting ${meeting.id}`, meeting.name, meeting.type, meeting.schedule.text, next];
  if (meeting.people.length > 0) parts.push(`with ${meeting.people.map((p) => p.displayName).join(", ")}`);
  if (meeting.openCount !== null) parts.push(`${meeting.openCount} to say`);
  return parts.join(" | ");
}

/** `meeting 2 | 19.11.2026 09:00-09:15 | Weekly Standup`, plus `| moved from 19.11.2026` or `| cancelled`. */
export function occurrenceLine(o: MeetingOccurrence, timeZone: string): string {
  const day = toLocalDate(o.startAt, timeZone);
  const endDay = toLocalDate(o.endAt, timeZone);
  const end = `${endDay === day ? "" : `${formatDate(endDay)} `}${toLocalTime(o.endAt, timeZone)}`;
  const parts = [
    `meeting ${o.meetingId}`,
    `${formatDate(day)} ${toLocalTime(o.startAt, timeZone)}-${end}`,
    o.name,
  ];
  if (o.status === "moved") parts.push(`moved from ${formatDate(o.occursOn)}`);
  if (o.status === "cancelled") parts.push("cancelled");
  if (o.noteId !== null) parts.push(`note ${o.noteId}`);
  return parts.join(" | ");
}

const KIND_TITLES: Record<StandupKind, string> = {
  done: "Done",
  started: "Started",
  updated: "Updates",
  blocked: "Blocked",
};

/** `- #12 Title [Project] (part of #3 Rack) | changed status ...; ... | 2 new comments, last by you: "..." | again` */
export function standupItemLine(item: StandupItem): string {
  const head = [
    `- #${item.todo.id} ${item.todo.title}`,
    item.project ? `[${item.project.name}]` : "",
    item.parent ? `(part of #${item.parent.id} ${item.parent.title})` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const parts = [head];
  if (item.changes.length > 0) parts.push(item.changes.join("; "));
  if (item.lastComment) {
    const count = item.newCommentCount === 1 ? "1 new comment" : `${item.newCommentCount} new comments`;
    parts.push(`${count}, last by ${item.lastComment.actor}: "${oneLine(item.lastComment.excerpt)}"`);
  }
  if (item.again) parts.push("again");
  return parts.join(" | ");
}

/** `Weekly Standup: 2 todos added by hand (next date 12.11.2026):` then `- #5 Budget [Lab] | in_progress | due 12.11.2026`. */
export function meetingTodosText(list: MeetingTodos, name: string): string {
  const next = list.nextOn === null ? "no next date" : `next date ${formatDate(list.nextOn)}`;
  if (list.items.length === 0) return `${name} has no todos added by hand (${next}).`;
  const count = list.items.length === 1 ? "1 todo" : `${list.items.length} todos`;
  return [
    `${name}: ${count} added by hand (${next}):`,
    ...list.items.map((item) =>
      [
        [
          `- #${item.todo.id} ${item.todo.title}`,
          item.project ? `[${item.project.name}]` : "",
          item.parent ? `(part of #${item.parent.id} ${item.parent.title})` : "",
        ]
          .filter(Boolean)
          .join(" "),
        item.todo.status,
        item.dueOn === null ? "" : `due ${formatDate(item.dueOn)}`,
      ]
        .filter(Boolean)
        .join(" | "),
    ),
  ].join("\n");
}

/** The standup list grouped by kind, then what was said and how many were dismissed on the date. */
export function standupText(standup: Standup, name: string, timeZone: string): string {
  const { counts } = standup;
  const total = counts.done + counts.started + counts.updated + counts.blocked;
  const lines = [
    `${name} on ${formatDate(standup.on)}: ${total} to say (done ${counts.done}, started ${counts.started}, ` +
      `updates ${counts.updated}, blocked ${counts.blocked}), counting from ${formatDateTime(standup.since, timeZone)}.`,
  ];
  const kinds = Object.keys(KIND_TITLES) as StandupKind[];
  for (const kind of kinds) {
    const items = standup.items.filter((i) => i.kind === kind);
    if (items.length > 0) lines.push(`${KIND_TITLES[kind]}:`, ...items.map(standupItemLine));
  }
  if (standup.items.length === 0) lines.push(total === 0 ? "Nothing to say." : "Nothing of these kinds.");
  if (standup.said.length > 0) {
    lines.push(
      `Said on ${formatDate(standup.on)}: ${standup.said.map((s) => `#${s.todo.id} ${s.todo.title}`).join(", ")}`,
    );
  }
  if (standup.dismissedCount > 0)
    lines.push(`Dismissed on ${formatDate(standup.on)}: ${standup.dismissedCount}`);
  return lines.join("\n");
}

/** "repeat #12 | 17.11.2026 09:00-10:00 | Team report [Lab]": a date of a repeating todo's planned time. */
export function plannedLine(o: BlockOccurrence, timeZone: string): string {
  const day = toLocalDate(o.startAt, timeZone);
  const endDay = toLocalDate(o.endAt, timeZone);
  const end = `${endDay === day ? "" : `${formatDate(endDay)} `}${toLocalTime(o.endAt, timeZone)}`;
  const project = o.project ? ` [${o.project.name}]` : "";
  const parts = [
    `repeat #${o.todo.id}`,
    `${formatDate(day)} ${toLocalTime(o.startAt, timeZone)}-${end}`,
    `${o.todo.title}${o.todo.status === "done" ? " (done)" : ""}${project}`,
  ];
  if (o.status === "moved") parts.push(`moved from ${formatDate(o.occursOn)}`);
  if (o.status === "cancelled") parts.push("cancelled");
  return parts.join(" | ");
}

/** "#12 Team report | every week on Mon | next 16.11.2026 | done 3 times, last 09.11.2026 | planned ...". */
export function recurringLine(r: RecurringTodo, timeZone: string): string {
  const parts = [`#${r.todo.id} ${r.todo.title}`, r.text];
  parts.push(r.ended || r.nextOn === null ? "ended" : `next ${formatDate(r.nextOn)}`);
  if (r.doneCount > 0) {
    const last = r.lastDoneAt === null ? "" : `, last ${formatDate(toLocalDate(r.lastDoneAt, timeZone))}`;
    parts.push(`done ${r.doneCount} time${r.doneCount === 1 ? "" : "s"}${last}`);
  }
  if (r.plan) parts.push(`planned ${r.plan.schedule.text}`);
  return parts.join(" | ");
}

/** Minutes as hours with one decimal: "4.5 h". */
export const hoursText = (minutes: number): string => `${Math.round(minutes / 6) / 10} h`;

/** The name of a group of worked time: a project, the Inbox, or blocks with only a title. */
export const statsGroupText = (g: StatsGroup): string =>
  g.kind === "inbox"
    ? "Inbox"
    : g.kind === "untitled"
      ? "Blocks with their own title"
      : (g.project?.name ?? "Project");

const NOTIFICATION_TEXT: Record<NotificationList["items"][number]["kind"], string> = {
  assigned: "assigned it to you",
  mentioned: "mentioned you",
  commented: "commented",
  action_needed: "marked it ACTION NEEDED",
};

/** `* 26.11.2026 14:05 | S7#12 Book the van | bobo commented: "Done."`; `*` = unread. */
export function notificationsText(list: NotificationList, timeZone: string): string {
  if (list.items.length === 0) return "No notifications.";
  const lines = list.items.map((n) => {
    const what = `${n.actor} ${NOTIFICATION_TEXT[n.kind]}${n.excerpt ? `: "${n.excerpt}"` : ""}`;
    return `${n.readAt === null ? "* " : "  "}${formatDateTime(n.createdAt, timeZone)} | ${n.todo.ref} ${n.todo.title} | ${what}`;
  });
  return [`${list.unreadCount} unread (* marks them):`, ...lines].join("\n");
}
