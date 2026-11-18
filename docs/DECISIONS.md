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
