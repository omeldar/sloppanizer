# Changelog

What changed in each release of Sloppanizer. New entries go under "Unreleased"; `pnpm release <version>`
moves them under the version's heading, sets the version everywhere and tags the commit `v<version>`.
Versions follow `major.minor.patch`: a new minor release when the web app needs something new from the
server, a patch release for fixes. While the server is on an older minor release than the web app, the
app shows "Sloppanizer is updating".

## Unreleased

- Draw: every Markdown field (todo descriptions, comments, notes) has a Draw button next to Attach file.
  It opens a canvas for mouse, finger or pen (with pressure): six colours, four sizes, eraser, undo, redo
  and clear on a white page, also on phones and in the dark theme. Insert stores the drawing as a PNG and
  puts it where the cursor was (S5#17).
- Draw on your phone: the same dialog shows a QR code. The phone opens it without signing in, draws full
  screen and taps Send; the computer shows the drawing to insert. The code works once, for 10 minutes,
  only for that dialog, and the file counts against the account's file limit (S5#17).
- Edit drawing and copies: a drawing keeps its strokes inside the PNG. "Edit drawing" under a drawing (in
  a description, a note or your own comment) opens it to change it; saving stores a new file and links it
  in place of the old one. A new drawing can start from a copy of a recent one (S5#17).

## 1.2.2 (2026-11-27)

- Sign-up goes through omeldar as soon as "Sign in with omeldar" is on (`SLOPPANIZER_AUTH=both`, not only
  `oidc`): /signup opens "Create an account with omeldar", and the own sign-up API answers 410. A sign-up
  here made an account auth.omeldar.com never knew, which then could not move its sign-in (S5#18).
- "Move my sign-in" also offers "Create an omeldar account", for accounts made here after the admin's
  import to auth: omeldar then has no account with their Sloppanizer username and password, and says the
  password is wrong. The new omeldar account is bound to theirs once the admin approves it at omeldar
  (S5#18).
- Notifications open the todo where it lives, from any tab: an own todo opened from a shared project's tab
  went to "this todo does not exist" (it was looked up in the shared project); it now opens your own tab,
  and a shared project's todo opens that project's tab, also from another shared project (S5#19).

## 1.2.1 (2026-11-27)

- Notifications: long comment text and the hover background stay inside the panel. The panel was 40px
  wider than its popover, so text ran past the border; long words and links now wrap, and a long todo
  title ends in "…" (S5#12).
- "Confirm it is you" with omeldar asks auth.omeldar.com for the account you are signed in with. When the
  browser is signed in at auth as another account (e.g. omerovie while you use akotami), the popup now asks
  for your account, prefilled and editable, instead of showing the other one read-only (S5#10).

## 1.2.0 (2026-11-27)

- The breadcrumb at the top left links back: every step but the page you are on is a link (keyboard, a
  middle click opens a new tab). A project page starts with "My todos", which in a shared project goes back
  to your own todos; a subtask shows its parent (S5#8).
- Move a todo into a shared project: its Project field lists your shared projects too. The todo is copied
  there with its comments, checklist, subtasks, labels, people, web links and files, assigned to you, and
  the original is marked done with a link to the copy. Inside a shared project the field lists your own
  projects and Inbox, to move it back (S5#7).
- Sharing a project shows who has access: each person with Owner or Member and since when, "(you)", users
  suggested as you type, and a line saying who was added (or already had access); an unknown username says
  so. Open it from a shared project's tab ("Share" under its name) or the sidebar menu ("Share and
  settings") (S5#7).
- API: `POST /todos/{id}/move` (`spaceId`, `projectId`), and `members[].addedAt` on shared projects. MCP:
  `move_todo` (S5#7).
- Projects can open as a board: Settings, Projects, "Open projects as" List or Board. Saved to your
  account, so every device and shared project follows it; the switch on a project still changes the view
  for that visit (S5#3).
- One-time meetings: in the Planner, Plan time has "Work" and "Meeting"; a meeting there happens once,
  on that day, and counts as time in meetings. New meeting on the Meetings page has "Repeats" and "Once".
  A one-time meeting moves with a drag without asking which dates, and removing it deletes it (S5#5).
- People in meetings: add people (from People, Sloppanizer users, or a new "First Last") to any meeting,
  in its dialog or on its page. Statistics has "In meetings with whom": the hours in meetings per person
  (S5#5).
- MCP: `plan_meeting` plans a one-time meeting with its people, `meeting_people` adds or removes people,
  `list_meetings` shows them and `work_stats` lists the meeting time per person (S5#5).
- API: a meeting's `schedule` without `rule` is a one-time meeting; meetings have `oneTime` and `people`
  (`people`, `addPeople`, `removePeople` on create and update); occurrences have `oneTime`; `/stats/overview`
  has `meetingPeople` and `meetingMinutesWithoutPeople`. Export format 9 adds `meeting_people` (format 8 and
  older still restore). Migration 0015 (S5#5).
- Notifications: a bell in the top bar with the unread count. You hear when someone assigns you a shared
  todo, mentions you with `@username` in a comment, comments on a shared todo assigned to you (or on an own
  todo, by one of your API tokens), or marks a todo of yours "action needed". Nothing you do yourself in the
  browser notifies you; what your tokens (MCP clients, scheduled runs) do does. Opening one marks it read
  and goes to the todo; "Mark all read" clears them (S5#6).
- Action needed: a marker with a reason on a todo, for what only you can do (an assistant's scheduled run
  sets it when it gets stuck). It shows as a badge in lists, as a note at the top of the todo with "Done,
  remove", in its own group at the top of Next up, and as a filter in the Inbox and project lists (S5#6).
- MCP: `update_todo` and `create_todo` take `actionNeeded` (a reason, `""`, or `null` to remove it),
  `list_todos` filters by it, todo lines show `ACTION NEEDED: …`, and `list_notifications` lists (and can
  mark read) the notifications (S5#6).
- API: `actionNeeded` on todos (create, update, bulk) and `?actionNeeded=true|false` on `GET /todos`;
  `GET /notifications` and `POST /notifications/read` (never inside a shared project). Migration 0016 (S5#6).

## 1.1.1 (2026-11-26)

- Date fields on a todo, in New todo and in a repeat's "Ends" no longer show a second border with a
  gap left and right around the field (S5#1).
- Statistics: "When you work" shows worked time per weekday, as the average of one such day (and the
  total and number of days in the table), instead of a weekday-by-hour grid. That grid added up every
  Wednesday of the period in one cell, so a single hour could read "2 h" (S5#4).

## 1.1.0 (2026-11-26)

- Move your sign-in to omeldar: accounts that still sign in with their Sloppanizer password see a line
  under the top bar and a section on the Account page; "Move my sign-in" binds their omeldar account
  (auth.omeldar.com) after a fresh sign-in there. "Later" hides it for a day. With
  `SLOPPANIZER_LOCAL_LOGIN_UNTIL` the own login, sign-up and reset stop on that day; the banner and the
  login page name it beforehand.

- Shared projects: a todo can be assigned to one member ("Assigned to" in the todo, `@username` on its
  row). Only members can be assigned; someone who leaves is taken off its todos. Your own Next up lists
  the todos assigned to you in shared projects under "Assigned to you", each with the project it comes
  from; tick it done there or open it in its project (#15).
- MCP: the lists, Next up, overview, search and list_projects include the shared projects you are a
  member of. Their todos read `S7#12`, with project and assignee; `scope` and `assignee` filter them, and
  get_todo, update_todo (`assignee`), create_todo, mark_done, add_comment, get_activity and check_item
  work on them. API tokens of a member may now work in a shared project with the token's scope (#15).

## 1.0.0 (2026-11-19)

- Projects: edit a project's name, description and color from the project page or its menu in the
  sidebar. New projects start with a color no other project uses yet (#17).
- Releases have real versions (this changelog, `pnpm release`, git tags `v<version>`); the web app and
  the server image carry the version and the commit (#16).
- A banner says when Sloppanizer is updating (the server is still on the previous release for a few
  minutes) and when a new version is ready in an old open tab, with a Reload button (#16).

- Recurring view (`g r`): every repeating todo once, with its rule, next date, how often it was done
  and its planned time. Marking one done never hides it (#12).
- Planned time repeats with a repeating todo: plan it once and it comes back on every date, also after
  one is done. Move, resize or remove one date, this and following, or all, like a calendar. The calendar
  feed, MCP (`list_plan`, `plan_time` with `repeat`, `list_recurring`) and exports include it (#12).

- Planning time for a todo in the Planner also plans it for that day, so it shows in the Week view.
- Settings, Calendar feed says that calendar apps pick up changes only every 8 to 12 hours, some once a
  day.
- Statistics (`g c`): worked time per project, per requester and per week, focus next to meetings,
  created vs done, when you work (weekday × hour), done per day and time to done, for this week, 4
  weeks, 3 months, this year or any dates; every chart also as a table. Worked time is planned time
  that has already happened. MCP tool `work_stats` (#18).

## 0.1.0

Everything before numbered releases: todos, notes, people, the planner, meetings, accounts, the hosted
MCP server and the AI assistant. See the git history for details.
