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

## 2026-11-18 Planned time plans the day (Week view in sync)

The Week view lists todos by their planned day; planner blocks did not set it, so planned time never
showed there. Creating a block for an open todo, moving it to another day or giving it to another todo
now sets that todo's planned day (a date change in its history, by whoever planned it). Deleting a block
leaves the planned day. Planned time that repeats with a todo (#12) does not move the todo's date: that
would shift the repeat itself. Blocks made before this change keep their todos' planned days as they were.

## 2026-11-18 Statistics (#18)

**Worked time is planned time that has already happened.** There is no timer, so the honest measure is
time blocks and planned dates of repeating todos whose end has passed, cut to the period. The page says
so. A block counts for its todo's project (Inbox without one, "Own title" for blocks without a todo) and
fully for each requester of its todo. Meetings are counted apart, never as worked time.

**Charts without a library.** Small SVG and HTML charts in features/stats/charts.tsx, nothing from a CDN.
Every bar list names and values each bar in text, so bars use one color (the validated blue) with the
project's own swatch beside the name; the user-picked project colors fail a chart palette check (too
light, too close for colorblind readers) and are kept as identity only. Two-series charts use the
validated blue and orange (checked against both app surfaces) with a legend; heatmaps use one blue ramp
in five steps, selected separately for dark and light. No stacked "hours per project per week" chart: it
would need more distinguishable colors than projects can have; the week's tooltip and table list its
projects instead. Every chart has a Table view with all its numbers.

## 2026-11-23 Sign in with omeldar

**The browser starts it, the API finishes it.** The web app (Vercel) and the API (VPS) are different hosts,
so there is no shared cookie. The web app builds the sign-in address with omeldar's client (no secret) and
keeps the pending sign-in in sessionStorage; the callback page posts the query and the pending sign-in to the
API, which exchanges the code with the client secret and returns the same session tokens as the own login.
One code path for sessions, refresh, multi-account and the MCP consent page.

**Who is who.** `accounts.auth_subject` holds the person's `sub`. First sign-in: by `sub`, else the
imported account named by `legacy_id` while it is unbound, else a new account (a free username like the
one at auth). Never by username or email, so a new person called "anna" does not get the old anna's data.
A Sloppanizer account disabled here stays disabled even when auth lets the person in; a pending one
becomes active (auth approved it).

**Confirm it is you in a popup.** A full redirect would lose the page and the waiting request. The
popup's callback hands the answer back over a BroadcastChannel: auth's pages set
Cross-Origin-Opener-Policy, which cuts `window.opener`.

**The client file is vendored unchanged** (`omeldar-auth.ts` in the server and the web app, excluded from
lint and formatting) so it can be updated by copying. The server adds the two Web Crypto types it expects
from the DOM lib (`src/webcrypto-types.d.ts`).


## 2026-11-25 Assignees in shared projects, "Assigned to you", shared todos in MCP (#15)

**One assignee per todo, only in shared projects.** `todos.assignee_id` points at a user account (ON DELETE
SET NULL). The server sets it only when the todo's account is a space and the user is a member of it
(active admins in the Sloppanizer project); anything else, also on personal todos, is a 422 with the same
answer for unknown names and non-members. A member who leaves or is removed is taken off every todo of that
project in the same transaction, with an `assignee_changed` line in each history by whoever removed them.
Todos never move between accounts, so a todo cannot leave its shared project with an assignee; moving it to
another project inside the shared project keeps it. A repeat's next todo keeps the assignee while they are
still a member. Assignees are left out of exports (`LOCAL_COLUMNS`), like comment token ids: they are
account ids of this server, and shared projects are not exported anyway.

**"My list" is Next up, worked out per project, not copied.** Your own tab's Next up shows "Assigned to you"
above the ranking (left out while a project or label filter is set): each shared project's own `/next` with
`assignee=me`, merged by score (one scoring function, same day, so scores compare), each row with a
"from <project>" badge in the project's color. The title opens the todo in that project's tab, where every
change is made; the box marks it done right there through the project (the `space` option of `api()`, so
the same membership check as a project tab). Nothing is stored on your own account, so there is nothing to
keep in sync. Inbox, Week and Board stay your own todos only; filters select own projects and labels.

**API tokens may enter shared projects.** Replaces "shared projects work from the web app only" (2026-11-23):
MCP clients are tokens, and the feature is to read and assign shared todos through them. A token of a
member's own account may send `X-Sloppanizer-Space` on the same routes a session may, with the token's
scope (a read token only reads); the history names "Member via <token name>". `GET /spaces` and
`GET /spaces/{id}` accept tokens (read); creating, renaming, members and deleting stay browser-session only.
Membership is checked on every request exactly as for sessions, so a token never reaches a project its
account is not in (tests: assignees.test.ts, "no path leaks").

**MCP: shared todos are `S<project>#<n>`.** Todo numbers are per account, so `#12` stays an own todo and
`S7#12` is todo 12 of shared project 7. `list_todos`, `next_up`, `overview`, `search` and `list_projects`
add the shared projects (each under its own heading, or ranked in for `next_up`), with `scope`
(all, own, shared) and `assignee` ("me", "none", "anyone", a username; own todos count as "me").
`get_todo`, `update_todo` (with `assignee`), `mark_done`, `add_comment`, `get_activity` and `check_item`
take `S7#12`; `create_todo` takes a shared project as `project` ("S7" or its name) and `assignee`. The other
tools (subtasks, links, web links, planning) stay on own todos for now. `next_up` ranks in only todos
assigned to the user by default. JSON answers keep their old shape and add a `shared` key when the account
is in shared projects.
