# Decisions

Newest last. An entry that replaces an older one says so.

## 2026-11-14 Hosted MCP: token first, OAuth after

"MCP support" means an MCP endpoint in the hosted API that every account can use, not only the local stdio
server. Eldar chose "both, token first": `POST /api/v1/mcp` with an API token as bearer, then OAuth so
claude.ai custom connectors work.

## 2026-11-14 Branches and releases

Feature work goes on `feat/*` branches. Finished packages of features are merged into `dev` by Claude and
pushed (nothing deploys from `dev`). A release, `dev` into `main`, happens only when Eldar says so.
Replaces the step 5 habit of pushing straight to `main`.

## 2026-11-14 Direction: an AI-assisted planner that stays a simple todo app

Sloppanizer is meant as an AI-assisted planner for todos, and at the same time a plain todo list for things
not to forget (quick capture must stay quick, no AI needed). The AI inside the app is pluggable per account:
the Claude API (key stored on the server, works everywhere) or a local Ollama (the browser talks to it, so
only on that PC). Same features for both. Claude through the MCP connector stays as well.

## 2026-11-18 Meetings and the standup list (#13)

**Series model, reusable for repeating planner blocks (#12).** A meeting owns one or more series
segments: a schedule rule anchored at the segment's first date, an optional last date, a wall-clock start
time and a length. Single dates are changed through exceptions keyed by the original date (moved with
their own instants, or cancelled), like Google's original start time. "This one only" writes an
exception; "this and following" ends the segment the day before and starts a new one (the rule shifted by
the same days, or only "this one" is offered when no rule can say it); "all" changes the segment that
holds the date, so on a split repeat it says "from 27.11. on". Times stay on the wall clock in the
account's zone: a 09:00 meeting stays at 09:00 across DST and a zone change.

**The standup list is worked out, not stored.** It comes from the todos' history after the meeting's
window start (the last meeting date before setup, editable as "Count from"). Marks (said or dismissed)
are kept per standup and per meeting date, with the time of the newest activity the list showed. Activity
after that time brings a todo back, marked "new since you said it". Unticked items carry over to the next
date on their own. A todo in progress that a standup never marked is always on its list, even when it was
untouched for weeks, so the first list shows everything in progress.

**Answers to the open questions.**
- Marks are per standup, not across all standups.
- A dismissed todo comes back when it gets new updates, like a said one.
- Changes of only the due date, labels or project do not count as updates. Comments, description,
  checklist, subtasks, links, title, status and people do.
- Meetings are not in the calendar feed (they are usually in the work calendar already). Plan my day
  treats them as busy.
- The calendar feed (services/calendar.ts) leaves meetings out on purpose, as decided above; it is not
  a gap to fill.
- Subtasks are their own items, with the parent's title shown.

**The rest.** A meeting has a type, Standup or Other, preselected from the name. There is no "held"
button: a meeting happens on its dates. Each date can have one note (a normal note, linked). The summary
by the assistant runs only on its button and saves nothing.

## 2026-11-18 Todos on meetings, due at the next meeting, blocked on standups (#14)

**Todos added by hand.** Any meeting, Standup or Other, can have todos added by hand (fixed topics). The
link is its own table (meeting_todos), scoped per account like every other one. A todo stays on the
meeting on every date until the user removes it: ticks, done and the standup rules never touch it. On a
standup it is its own group under the worked-out list; the same todo can also be on that list when it
has news, because the list is about updates and the group is about topics. At most 100 per meeting.

**Due at next meeting.** A button sets the due date to the day of the meeting's next date that has not
ended: cancelled dates are skipped, a moved one counts on the day it moved to. Adding a todo to a meeting
never changes its due date.

**Blocked todos on standups.** Like a todo in progress, a blocked todo that a standup never marked is
always on its list, also without changes, until it is said or dismissed there. After that only new
updates bring it back. The rules per status are one pure function (services/standup-rules.ts).

## 2026-11-18 Versions and the updating banner (#16)

**One version, set at release.** The root package.json holds the release version; `pnpm release <version>`
copies it into every package, moves the changelog's Unreleased entries under it, commits and tags
`v<version>`. A test fails when a package carries another version. The server image gets the version and
commit as labels (and the commit in its start log); the web build reads its package.json and the commit
(Vercel's variable, else git). The health route answers only `{ ok, version }`.

**When the banner shows.** "Updating" only while the server is on an older *minor* release than the web app
(or below `MIN_SERVER_VERSION` when the web app declares one), so a fix release of one side never shows it.
"A new version is ready" whenever the server is newer than the page. Versions are polled from the health
route, no header on every answer, so CORS stays as it is. While updating, an unknown-route 404, an
"Unrecognized key" 422 or an answer the app cannot read turns into "available in a few minutes". The
banner is a grid row under the top bar, so it never covers the tab bar or the page.

**Not done here.** Bumping to the first real version (proposed 1.0.0) is part of the next release, by
`pnpm release`, when Eldar says to release.

## 2026-11-18 Recurring todos: their own view, and planned time that repeats (#12)

The full version was built (series with single changes), not the fallback.

**A repeat of todos is a chain.** Marking a repeating todo done makes the next todo (recurrence_prev_id
points back), as before. The Recurring view shows each chain once by its newest todo: rule, next date,
how often it was done, planned time. Done never hides it there.

**Planned time is a series owned by the chain.** It is a `series` row with owner_kind 'todo' and todo_id =
the chain's open todo, moved to the next todo when one is made and back when an untouched next is undone
(services/repeat-plan-owner.ts). Deleting the open todo deletes its planned time (cascade), like single
blocks. One planned repeat per chain (with parts after "this and following"); more time is single blocks.

**Its own rule, copied from the todo's.** Planning makes a schedule rule from the todo's repeat, moved to
the weekday (or day of month) it was planned on: time planned on Tuesday for a Monday todo comes back every
Tuesday. Changing the todo's rule later leaves the planned time as it is; stopping the repeat (no rule, or
counted from done) or passing its last date ends the planned time today, and past dates stay as history.

**Done comes from the todos, not from the series.** A planned date belongs to the newest todo of the chain
dated on or before it (shared `todoForDate`); it shows done when that todo is done. So no "done" exception
kind was needed; series_exceptions stay moved or cancelled.

**Repeats counted from the done date get no planned repeat.** Their dates are not known ahead; time for
them is planned one date at a time (the dialog and the API say so).

**This / following / all** work exactly like meetings: the edit logic moved from meetings into
services/series-editor.ts, which takes an owner. Cancelling all removes the planned time.

**Elsewhere.** The calendar feed has one event per planned date (moved ones at their new time, cancelled
ones left out, UID per date). MCP: list_plan shows planned dates, plan_time takes `repeat`, list_recurring
lists the repeats; changing single dates stays in the app, like meeting dates. Export format 8 carries the
rows; a todo's Markdown lists its planned time. All of it is scoped per account like the rest.

**Migration note.** Drizzle runs migrations in one transaction with foreign keys on, so `PRAGMA
foreign_keys=OFF` in a generated table rebuild does nothing and the drop cascades. 0008 keeps
series_exceptions aside during the rebuild; check any future generated rebuild for the same.

