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

## 2026-11-25 Moving to omeldar, and the end of the own login

**A signed-in account binds its omeldar account itself.** Until now an account was bound only on a sign-in
with omeldar, through the `legacy_id` auth's import sets. That needs the import to have run for that
person; otherwise the sign-in makes a new, empty account. "Move my sign-in" binds from inside the session
instead: Sloppanizer's own "confirm it is you" first (within 10 minutes), so a stolen session cannot bind
someone else's omeldar account and keep the account after the session is revoked; then a fresh sign-in at
omeldar (`max_age=0`, in a popup like "confirm it is you", the username as `login_hint`). It refuses an
omeldar account that is bound to another account or whose `legacy_id` names another account, and an account
that is already bound. It binds `auth_subject` only: name and role follow at the next sign-in with omeldar,
like everyone's, so the move itself changes nothing else (an admin is not demoted mid-session). The own
credentials stay, for rollback. Each move is a `move_signin` line in the admin log.

**The end is a date the admin sets, not a fixed 30 days.** `SLOPPANIZER_LOCAL_LOGIN_UNTIL=YYYY-MM-DD`, the
day the own login stops (from 00:00 in `SLOPPANIZER_DEFAULT_TZ`). Unset means no end, so shipping this
changes nothing until the date is set; "30 days after the prompt ships" is the date 30 days after the
release. A date, not a duration from start, so restarts and redeploys never move it.

**From that day the own login stops for everyone, bound or not.** The login, passkey login, sign-up, setup
and reset answer 410 with a pointer to omeldar, before the credentials are checked, so the answer says
nothing about whether an account exists or moved. Refusing only unbound accounts would keep a second way in
for bound ones and would need the password checked first. Sessions that are still open keep working, and
"confirm it is you" with the own password or passkey still works for them, so someone who did not move in
time can still move before signing out. People who never moved and have no open session sign in with
omeldar: if auth imported them, with their old username and password (the `legacy_id` binding); otherwise
the admin helps. It only counts with `both`: with `local` there is nothing to sign in with instead (and
rollback must stay one switch), with `oidc` the own login is already off. The banner shows only with
`both`; with `oidc` an unbound account is bound at its next sign-in with omeldar.

**Shown once a day after "Later", never once it ended.** "Later" is remembered per account in this browser
for 24 hours. From 7 days before the end the line is amber; after the end it stays and has no "Later".

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

## 2026-11-26 How project pages open (S5#3)

lueoeng asked to make "Board" the standard view of projects. It is one choice per account, in Settings,
Projects ("Open projects as List / Board"), stored on the account (`accounts.project_view`, like the date
formats) rather than in the browser, so it follows the person to every device and into the shared projects'
tabs (the web app always asks for the account as the person's own, never through a shared project). `?view=list|board` in a
project's address still wins, and the List / Board switch on the page only sets it when it differs from the
choice, so links stay clean. Not done: remembering the last view per project. Two places deciding the view
would make "why does this one open as a list?" hard to answer; it can follow if one default is not enough.

## 2026-11-26 One-time meetings and people in meetings (S5#5)

omerovie asked for meetings that happen once, planned straight from the planner, and for people on
meetings, to see with whom the time in meetings went.

**A one-time meeting is a meeting with one single-date segment**, not a new kind of time block. It is a
meeting in every other respect (a note per date, todos added by hand, a type, a standup list if wanted), and
Statistics, Plan my day, the MCP tools and the export already read meetings through their series. The API
says it by leaving out `schedule.rule`: the server stores a daily rule with `endsOn = startsOn`, and
`oneTime` (on the meeting and its occurrences) is "one segment whose first date is its last". A repeat that
is later cut down to one date the same way also reads as once, which is what it is. In the planner a drag
moves its only date with scope "this" (an exception, so the note and marks keep their date key) without
asking, and "Cancel date" becomes "Delete", because cancelling the only date is deleting the meeting.

**People belong to the meeting, not to each date** (`meeting_people`, cascading from both the meeting and
the person, at most 50). Per-date attendance would answer "who was there on 12.11." too, but nobody asked
for it, and every date of a repeating meeting would need ticking. Picking works like a todo's people: a
person, a Sloppanizer user, or a new "First Last" that is added to People.

**Time per person** counts each meeting date in full for every person of its meeting, cut to the period and
to now like the rest of the meeting time, and the top 10 are listed. Minutes of meetings without people are
reported on their own (`meetingMinutesWithoutPeople`) so the list never looks like it covers all meeting
time.

## 2026-11-26 Notifications and the action needed marker (S5#6)

akotami asked for notifications ("when they get tagged in a shared todo") and for a marker Claude can set
through MCP that shows until someone removes it, so scheduled runs can flag where the user has to act.

**What notifies whom.** Assigned (the new assignee of a shared todo), mentioned (`@username` of a member in
a comment), commented (a comment on a shared todo notifies its assignee; on an own todo its owner) and action
needed (a shared todo's assignee, every member when it is unassigned, an own todo's owner). One notification
per person and change. Nobody is notified of what they did themselves in the browser, but what their API
tokens do is: the scheduled runs act through the user's own token, and their comments and markers are the
news. Edits of a comment, due dates, status changes and the like do not notify; they are in the history.

**Where they live.** `notifications` belongs to the recipient's account but points at the todo in the
account it lives in (own or a shared project), with a foreign key that removes it with the todo. It is not
account data: never exported or restored (a restore replaces the todos, which removes their
notifications). A user keeps the newest 200; notifications of a shared project they left are dropped when
they next look. The routes are personal (403 inside a shared project); the web app sends them without the
project header from every tab. The bell polls every minute and on focus; there is no push or e-mail.

**The marker is a field of the todo,** not a label: a label would need to exist in every account and
shared project, could not hold the reason, and is easily removed by a bulk relabel without anyone noticing.
`actionNeeded` (reason, who, when) is set and removed through the normal todo update (so MCP, bulk and the
API get it at once), records an `action_needed_changed` line in the history, and `""` is a marker without a
reason. Mentions are plain text (`@username`); the comment box has no autocomplete yet.

## 2026-11-26 Moving todos into shared projects, and who has access (S5#7)

omerovie asked to pick shared projects in a todo's Project field, and for a view like Google's sharing
dialog that shows who has access.

**A move is a copy plus a closed original.** Todos never move between accounts (2026-11-25): ids, labels,
people, files and history are per account, and a shared project is its own account. So "move to a shared
project" (and back, or between two shared projects) is `POST /todos/{id}/move` with `spaceId` (null: your
own todos), sent from where the todo is. In one transaction the todo and its subtasks are copied there with
their comments (authors renamed the way that account names them: "you" in your own todos, "First Last"
in a shared project), checklist (it is in the description), labels (made there with the same color when
missing), people (Sloppanizer users by username, others found or made by name), web links, repeat rule and
the files their text shows (copied into that account's files, links rewritten, its quota checked). The copy
is assigned to the person who moved it when it lands in a shared project (it was theirs), and its first new
comment says where it came from and lists the links to other todos, which cannot cross accounts. The
originals are marked done directly (a repeating one makes no next todo: the copy repeats instead) and get a
comment naming the copy. Not deleted: their history, planned and worked time stay where they were, nothing
is lost if the copy was a mistake, and the way back is the same move. Planned time does not follow the
copy. Any member may move a todo of a shared project out of it, like any other change there; tokens with
write scope may move too (MCP `move_todo`), with the same membership check as every request.

**The project picker shows the other places.** A todo's Project field (and the `p` picker) lists the shared
projects after your own projects, marked "shared"; inside a shared project's tab it lists your own projects
and Inbox, marked "my todos", and the other shared projects. Picking one asks first, then opens the copy in
its own tab. Notes and New todo keep their pickers: a new todo can already be made in a shared project from
its tab.

**Sharing is "people with access", and adding is immediate.** There are no invitations to accept: an owner
adds a member by username and they have access at once (the project shows under Shared in their sidebar).
The dialog (sidebar, the project's menu, "Share and settings"; in the project's own tab, "Share" under its
name) lists each person with "(you)", Owner or Member and since when (`members[].addedAt`), suggests users
as you type, says who was added and who already had access, and shows the server's error for an unknown
username. Owners remove members, everyone can leave. Adding and removing members stays browser-session only.

## 2026-11-27 Sign-up only at omeldar once it is on; moving accounts auth never imported (S5#18)

**Why a member could not move.** auth.omeldar.com learns Sloppanizer's accounts only from the admin's import
(`import-sloppanizer` in omeldar/auth), run by hand on the VPS. With `SLOPPANIZER_AUTH=both` the own
sign-up stayed open, so an account made after the last import exists here only. "Move my sign-in" sends
that person to omeldar, which has no account of that name, and answers "wrong username or password",
whatever the password is (a "@" in it plays no part: auth compares the argon2id hash the import copied).

**Sign-up moves with `both`, not only with `oidc`.** As soon as omeldar is on, new accounts are made there:
the web app's /signup shows "Create an account with omeldar", the own sign-up routes answer 410
(`localSignup`, separate from `localLogin` so the own *login* stays until `oidc` or
`SLOPPANIZER_LOCAL_LOGIN_UNTIL`), and `/auth/config` reports `signupsOpen: false`. The first sign-in at
omeldar makes the Sloppanizer account as before, and auth's approval (`access: "approval"` for this
client) replaces Sloppanizer's. Needs `AUTH_SIGNUPS=open` at auth, or nobody can sign up anywhere.
Rollback is `SLOPPANIZER_AUTH=local`, which opens the own sign-up again.

**Moving without an imported account.** The move dialog offers "Create an omeldar account": the same
link flow (`/auth/omeldar/link/start`, popup, `/auth/omeldar/link`) with `prompt=create`, so auth shows its
sign-up page. The new omeldar account waits for approval there; the popup then says "Waiting for
approval", the person closes it and moves again once approved, signing in with the new account. The link
binds any omeldar account not already bound to, or imported from, another Sloppanizer account, so this
needs no change at auth. Re-running the import is the other way (same username and password, no
approval wait); both are fine and the import stays safe to repeat.

## 2026-11-27 The list checkbox selects; bulk changes from a selection bar (S5#14)

omerovie asked for the checkbox in Next up, Inbox and project lists to select a todo instead of marking it
done, with changes for all selected todos at once.

**Done is a round button, not the box.** Every strip now has a square selection box at the start and a
round check button at the end of the title line (shown on hover, focus and the cursor row; always on touch
screens and on done rows). The button does exactly what the box did: done or reopen, folding the row away,
with the undo toast. `x` stays "done or reopen" on the cursor row, because it is the documented key for it;
selecting by keyboard is `v` (vim's visual mode; the request suggested `x` only if it did not clash), and
`Esc` clears the selection. Shift-click selects the range since the last clicked box. "Assigned to you" on
Next up has no box: those todos live in other accounts (shared projects), and one bulk call reaches one
account only. They keep the done button.

**One bar, one call, one toast.** While todos are selected, a bar over that list shows the count, "Select
all N", Clear, and: Done, Status, Priority, Move, Add labels, Remove labels, Requested by, Add contacts,
Planned, Due, and in a shared project's tab Assign. Each is one `POST /todos/bulk` (several only past 200
todos, the route's limit) and a toast that says what changed ("Moved 4 todos to Work") with Undo. Undo
puts each todo back as it was: the fields the change touched, the full label, requested-by and contact
sets for those, grouped so todos that go back the same way share a call. Selection is per list (Next up's
Blocked list has its own), it stays after a change so several can follow, and todos that leave the list
(done, moved) drop out of it.

**Requested by replaces, after a warning.** As asked, it sets the full set; when any selected todo already
has someone, a dialog names those todos and their people and says what they will have instead. With
nobody to overwrite it applies at once. Contacts only add (removing is on the todo).

**The bulk patch grew instead of a new route.** `BulkPatch` gains the full `labels` set (for undo),
`requestedBy`, `addRequestedBy`, `removeRequestedBy`, `contacts`, `addContacts`, `removeContacts` and
`assignee`, with the same rules as `UpdateTodo` (a full set or add/remove, not both; assignee only in a
shared project). A person typed as a new name is created once, not once per todo (same transaction). The
MCP `bulk_update` takes the people fields too. The web app needs the server's new fields: minor release.

**No bulk move into shared projects.** A move into a shared project (or back to your own todos from its
tab) is a copy plus a closed original (2026-11-26), with a confirmation and a new tab per todo. Doing that
for many todos at once deserves its own design, so the bulk Move lists this tab's projects and Inbox only;
the todo's own Project field still moves one todo between accounts.

