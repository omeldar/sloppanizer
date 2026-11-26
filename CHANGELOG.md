# Changelog

What changed in each release of Sloppanizer. New entries go under "Unreleased"; `pnpm release <version>`
moves them under the version's heading, sets the version everywhere and tags the commit `v<version>`.
Versions follow `major.minor.patch`: a new minor release when the web app needs something new from the
server, a patch release for fixes. While the server is on an older minor release than the web app, the
app shows "Sloppanizer is updating".

## Unreleased

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
