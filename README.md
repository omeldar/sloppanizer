# organizer

A personal todo and notes app that runs on your own machine. Todos live in projects or the Inbox, carry
labels (scoped ones like `priority::high` work like GitLab's: one per scope) and remember who asked for them
and whom to ask about them. **Next up** ranks the open todos by priority, due dates, plans, age and how long
they sat untouched, and tells you why each one is where it is.

- Every todo has a thread: comments in Markdown and a line for each change.
- Subtasks (child todos, up to 5 levels) and Markdown checklists (`- [ ] Order cables`) you tick right in the
  description, both with progress.
- Links between todos: "blocks", "blocked by" and "relates to". A todo waiting on an open blocker leaves the
  Next up ranking until the blocker is done; the blocker gets extra points.
- Repeating todos: every day, weekday, week, month or year, or a number of days after it was done. Marking one
  done creates the next one with its dates moved.
- Notes: Markdown pages, alone or in a project, pinned ones first.
- Paste or drop images and files into any Markdown field; images show inline, other files are downloads.
- Diagrams: a ```` ```mermaid ```` block in a description, comment or note draws as a
  [Mermaid](https://mermaid.js.org) diagram (flowcharts, sequence diagrams, Gantt charts and more), in the
  app's theme. A diagram with a mistake shows its text and what is wrong.
- Board (Open, In progress, Blocked, Done) and a week planner, both with drag and drop and keys.
- Projects open as a list or a board, as you choose in Settings (saved to your account).
- Statistics: worked time (planned time that has already happened) per project, requester and week,
  meetings (also per person in them), created vs done, when you work, done per day and how long todos took, as charts and tables.
- Recurring: a view of every repeating todo with its next date and history. Time planned for a todo that
  repeats on a schedule repeats with it on every date; change one date, this and following, or all.
- Planner: reserve time in a week calendar for a todo or with a title (click a free slot, drag a todo from To
  plan or the Day row onto a day, drag a block to move or resize it); todos planned for a day without a time wait in a row above it. Phones show one day at a time.
  A free slot can also become a one-time meeting (Plan time, Meeting): a name and the people in it.
- Notifications (the bell): assigned to a shared todo, @mentioned in a comment, comments on your todos,
  and todos marked "action needed" (a marker with a reason, set by an assistant's run or anyone, shown
  until removed; filter lists by it, Next up shows them first).
- Meetings: repeating or once, with the people in them (from People; a new name is added there). Their
  time counts in Statistics, also per person ("In meetings with whom").
  Settings, Calendar feed gives a secret link to subscribe to in Google Calendar, Apple Calendar or Outlook.
- Web links on todos (tickets, docs, pull requests) with a label, and a new todo that takes notes, links, a
  planned day and a time slot at once.
- Works on phones: a drawer for the sidebar, a tab bar with a new todo button, bottom sheets for dialogs.
- AI assistant (optional, Settings, AI assistant): Plan my day proposes time blocks from Next up and the free
  time of the working day; Suggest steps proposes subtasks. Nothing is saved until you accept it. Runs on Claude
  (your Anthropic API key, stored encrypted on the server) or on a local Ollama in the browser on that computer
  (set `OLLAMA_ORIGINS` to the web app's origin for Ollama). Off, Sloppanizer is a plain todo app.
- Shared projects: a project several users work on together (sidebar, Shared, plus). Members open it in its
  own tab and get the whole app there: list, board, planner, notes, comments; the history names who did what.
  Owners add members by username (they have access right away; "Share" lists who has access, with their
  role and since when), rename and delete it; members can leave. A todo's Project field moves it into a
  shared project and back: it is copied there with its thread, subtasks and files, the original is done. A todo there can be assigned to
  one member ("Assigned to" in the todo); your own Next up lists what is assigned to you under "Assigned to
  you", with the project it comes from.
- Feedback: "report a bug / request a feature" in the status bar, the sidebar and the palette. Reports land as
  todos in the Sloppanizer shared project (all admins are members), labelled `type::bug` or `type::feature`,
  requested by the sender ("First Last" from the account page, else the username).
- Dates and times in your format: the region picked at sign-up presets it (31.12.2026 or 12/31/2026 and so
  on, 15:00 or 3:00 PM); change it on the account page. Date fields have a Monday-first calendar, time fields
  take 15:00 as well as 3 pm.
- Other users as people: the requester and contact pickers also find Sloppanizer users; picking one adds
  them to your people, linked to their account.
- Search over todos, notes, comments and people (ignores case and accents), in the palette and on its own page.
- People and contacts: a small directory of colleagues with team, email, the topics they help with and your own
  tags, so "whom do I ask about firewall rules?" has an answer. People statistics show who asks for how much
  and how fast it gets done.

- Web app at <http://organizer.localhost:4711>, keyboard first.
- REST API under `/api/v1` with generated docs.
- An MCP server, so MCP clients can read and plan your todos.
- Everything stays local: one SQLite file, no network requests, no CDNs. Export to a zip any time, write it to
  the export folder, and restore from it.

## Install and update

Needs Linux (WSL works) with a systemd user session, Node 24 (nvm is fine) and pnpm (`corepack enable`).

```sh
git clone <repo> organizer && cd organizer
deploy/install.sh                       # or: deploy/install.sh --token-name <name>
```

The script builds the checkout, copies a self-contained release to
`~/.local/lib/organizer/releases/<timestamp>/`, points `~/.local/lib/organizer/current` at it, writes the user
service `~/.config/systemd/user/organizer.service`, enables and restarts it and waits for the health check. If
the new release does not answer, it switches back to the previous one. It keeps the last three releases.

It also creates the API token for MCP clients in `~/.local/share/organizer/mcp-token` (mode 0600) if that file
does not exist yet. `--token-name` sets the token's name (default `assistant`); changes made through the MCP
server show that name in the history. On WSL it adds an `organizer` shortcut to the Windows Start menu.

To **update**, pull and run `deploy/install.sh` again. `deploy/install.sh --dry-run` prints the steps without
changing anything. The service and MCP clients run from `current`, never from the checkout, so working in the
checkout does not affect them.

Data lives in `~/.local/share/organizer/` (`organizer.db`, the cookie `secret`, `mcp-token`, `attachments/`,
`exports/` for **Write to folder** and `backups/` for the safety copies a restore makes).

## Run

The service starts with your user session. Commands:

```sh
systemctl --user status organizer
systemctl --user restart organizer
systemctl --user stop organizer
journalctl --user -u organizer -f      # logs
```

If the service stops when you close your last terminal, let your user services run without a login:
`loginctl enable-linger "$USER"`.

Settings (environment of the service, all optional): `ORGANIZER_PORT` (4711), `ORGANIZER_HOST` (127.0.0.1),
`ORGANIZER_DATA_DIR`, `ORGANIZER_ALLOWED_HOSTS` (organizer.localhost,localhost,127.0.0.1,[::1]),
`ORGANIZER_TZ` (system time zone). For a different port run `ORGANIZER_PORT=4712 deploy/install.sh`.

## API

- Base URL: `http://organizer.localhost:4711/api/v1`, health check `GET /api/v1/health` (no auth).
- Docs: <http://organizer.localhost:4711/api/docs>, OpenAPI JSON at `/api/openapi.json`. Open the app once in
  the same browser first: the docs use the app's session.
- Scripts authenticate with `Authorization: Bearer org_...`. Tokens are `read` (GET only) or `write`. Create,
  list and revoke them in the app under Settings, **API tokens** (`/settings/tokens`): a new token is shown once,
  copy it then. From the shell:

  ```sh
  ORGANIZER_DATA_DIR=~/.local/share/organizer \
    node ~/.local/lib/organizer/current/server/src/cli/token-create.ts --name scripts --scope read --out ~/organizer-read-token
  ```

  With `--out` the raw token goes into that file (0600) and is not printed. Token management, settings and
  restore work from the browser session only; a token gets 403 there.
- Uploads: `POST /api/v1/attachments?name=<file name>` with the raw file as the body (any type, up to 25 MB).
  The type is read from the file itself; PNG, JPEG, GIF and WebP show inline, everything else is served as a
  download. Files live in `~/.local/share/organizer/attachments/` and are part of the export.
- Search: `GET /api/v1/search?q=...` over todos, notes, comments and people.
- Web links: `POST /api/v1/todos/{id}/urls` (`{ urls: [{ url, label? }] }`), `PATCH`/`DELETE`
  `/api/v1/todos/{id}/urls/{urlId}`; `urls` on `POST /api/v1/todos` too.
- Shared projects: `GET`/`POST /api/v1/spaces`, `PATCH`/`DELETE /api/v1/spaces/{id}`,
  `POST /api/v1/spaces/{id}/members` (`{ username }`), `DELETE /api/v1/spaces/{id}/members/{accountId}`
  (browser session only; listing works with tokens too). Every other route acts inside a shared project with
  the header `X-Sloppanizer-Space: <id>`, from the session or a token of a member (with the token's scope).
  Assignees there: `assignee` (a member's username, `null` clears it) on `POST`/`PATCH /api/v1/todos`, and
  `assignee=me|none|<username>` on `GET /api/v1/todos` and `GET /api/v1/next`.
- Feedback: `POST /api/v1/feedback` (`{ kind: "bug" | "feature", title, description? }`).
- Users: `GET /api/v1/users?q=` finds users; `{ username }` works wherever a person reference does.
- Statistics: `GET /api/v1/stats/overview?from=YYYY-MM-DD&to=YYYY-MM-DD` (at most a year).
- Repeating todos: `GET /api/v1/todos/recurring`; planned time that repeats with one:
  `POST`/`GET`/`DELETE /api/v1/todos/{id}/plan`, `PATCH /api/v1/todos/{id}/plan/{date}` (this, following or
  all), `GET /api/v1/blocks/series?from=&to=` for its dates.
- Planner: `GET /api/v1/blocks?from=YYYY-MM-DD&to=YYYY-MM-DD[&todoId=]` (days in the account's time zone, at
  most 62), `POST /api/v1/blocks` (`{ todoId? , title?, startAt, endAt }`, ISO instants), `PATCH`/`DELETE`
  `/api/v1/blocks/{id}`.

## Sign in with omeldar (auth.omeldar.com)

Sign-in can move to the shared omeldar account service (OpenID Connect). Accounts keep their id, so data, API
tokens, MCP connections and calendar feeds stay as they are; only the sign-in step changes. The switch:

- `SLOPPANIZER_AUTH=local` (default): Sloppanizer's own login only.
- `both`: "Sign in with omeldar" next to the own login. The first sign-in at omeldar binds the account auth
  imported for that person (`legacy_id`), or makes a new one. Sign-up already happens only at omeldar
  ("Create an account with omeldar"; the own sign-up answers 410), so every new account is one auth knows.
- `oidc`: only omeldar. The own login, sign-up, setup, reset and password/authenticator/passkey changes
  answer 410; people manage those at auth.omeldar.com/account, admins approve people at auth.omeldar.com/admin.

Settings: `SLOPPANIZER_AUTH_CLIENT_SECRET` (required with `both`/`oidc` in production, the same value as
`AUTH_CLIENT_SECRET_SLOPPANIZER` at auth), `SLOPPANIZER_AUTH_ISSUER` (default `https://auth.omeldar.com`),
`SLOPPANIZER_AUTH_CLIENT_ID` (`sloppanizer`), `SLOPPANIZER_AUTH_REDIRECT_URI` (default: the first web origin +
`/auth/callback`). Roles follow the role set at auth on every sign-in. "Confirm it is you" opens a fresh
sign-in at omeldar in a popup. Auth's back-channel logout (`POST /api/v1/auth/backchannel-logout`) ends the
session of that sign-in. The web app serves `/.well-known/webauthn` so passkeys made on organizer.omeldar.com
work at auth.omeldar.com. Rollback: set `SLOPPANIZER_AUTH=local`; the own credentials were never changed.

**Moving people over, with an end date.** With `both`, everyone who still signs in with their Sloppanizer
password sees a line under the top bar (and a section on the Account page): "Move my sign-in" explains it,
asks them to confirm it is them here when the last sign-in is older than 10 minutes, then opens a fresh
sign-in at omeldar in a popup and binds that omeldar account to theirs (`POST /api/v1/auth/omeldar/link`;
never an omeldar account that already belongs to, or was imported from, another Sloppanizer account).
Accounts made here after the import have no omeldar account yet: "Create an omeldar account" in the same
dialog opens auth's sign-up in the popup, and the new account is bound once the admin approves it there.
"Later" hides it for a day. Accounts that moved never see it.

`SLOPPANIZER_LOCAL_LOGIN_UNTIL=YYYY-MM-DD` (optional, only with `both`) is the day the own login stops, from
00:00 that day in `SLOPPANIZER_DEFAULT_TZ`. Before it, the banner and the login page name the day; from it,
the own login, passkey login, sign-up, setup and reset answer 410 and point to omeldar, and the login page
offers only "Sign in with omeldar". Sessions that are still open keep working and can still move. Unset (the
default): no end, nothing changes. For "30 days from now", set it to the date 30 days after the release
ships. With `local` it is ignored, so rollback stays one switch.

## MCP server

### Hosted (every account)

The API serves MCP over Streamable HTTP at `/api/v1/mcp` (here `https://organizerapi.omeldar.cloud/api/v1/mcp`).
Create a token under Settings, API tokens, and send it as `Authorization: Bearer spz_...`. The panel of a new token
shows the URL and the Claude Code command:

```sh
claude mcp add --transport http sloppanizer https://organizerapi.omeldar.cloud/api/v1/mcp   --header "Authorization: Bearer spz_..."
```

The tools are the ones listed below, on the token's own account, in the account's time zone. They call the REST
routes with that token, so a read token can only read. Stateless: POST only, no session, no event stream.

Clients that sign in with OAuth (claude.ai custom connectors on web, desktop and phone, and most MCP clients)
need only the URL: add `https://organizerapi.omeldar.cloud/api/v1/mcp` as a connector and sign in. The client
registers itself (`/oauth/register`, RFC 7591), the browser shows the consent page of the web app
(`/oauth/authorize`: pick the account and read or read and change; needs a sign-in within the last 10 minutes),
and the client gets a refresh token (90 days, rotated on use) and an access token (30 days). The access token is
an API token named after the client: it shows under Settings, API tokens, and revoking it there disconnects the
client. Connecting the same client again replaces its old grant. Discovery: `/.well-known/oauth-protected-resource`
and `/.well-known/oauth-authorization-server`.

### Local stdio

A stdio MCP server for MCP clients, installed at `~/.local/lib/organizer/current/mcp/index.js`. It talks to the
running organizer through the REST API with the token from a file, so the token never sits in the client config.

Tools:

- Todos: `next_up`, `overview`, `list_todos`, `get_todo`, `create_todo`, `update_todo`, `bulk_update`,
  `mark_done`. Todos take requesters and contacts (people to ask) by id or by name, a `parent` (makes it a
  subtask) and a `repeat` rule. `mark_done` with `withSubtasks` also marks the open subtasks done and reports
  the next occurrence of a repeating todo.
- Subtasks, checklists and links: `add_subtasks`, `check_item` (by the number `get_todo` shows, or the exact
  text), `link_todos`, `unlink_todos`.
- Thread: `get_activity` (changes and comments, one line each), `add_comment` (signed with the token's name).
- Notes: `list_notes`, `get_note`, `create_note`, `update_note` (with `appendText` to add to the end).
- People and contacts: `list_people` (filter by topic, team, tag or text: "whom do I ask about X"),
  `get_person`, `create_person`, `update_person`, `list_topics`, `list_person_tags`.
- Search: `search` over todos, notes, comments and people.
- Statistics and backup: `people_stats` (one line per person: requested, open, done, median time to done,
  contact count), `export_to_folder` (writes an export zip to the export folder).
- Setup: `list_projects`, `create_project`, `list_labels`, `create_label`.
- Web links: `create_todo` takes `links`; `add_web_link`, `remove_web_link`.
- Planner (local time): `list_plan` (blocks, planned dates of repeating todos, meetings), `plan_time` (a
  todo or a title, a day, start and end or minutes; `repeat` for a repeating todo), `move_block`,
  `delete_block`, `list_recurring`, `work_stats` (time per project, requester and week, meeting time per
  person), `plan_meeting` (a one-time meeting with its people), `meeting_people` (add or remove people of
  any meeting).
- Action needed and notifications: `update_todo` / `create_todo` take `actionNeeded` (what the user has to
  do; `null` removes it), `list_todos` takes `actionNeeded: true`, `list_notifications` (`markRead`).

- Shared projects: their todos read `S7#12` (todo 12 of shared project 7) with project and assignee.
  `list_todos`, `next_up` (assigned to you, ranked in), `overview`, `search` and `list_projects` include
  them; `scope` (all, own, shared) and `assignee` ("me", "none", "anyone", a username) filter them.
  `get_todo`, `update_todo` (`assignee`), `mark_done`, `add_comment`, `get_activity` and `check_item` take
  `S7#12`; `create_todo` takes a shared project as `project` ("S7" or its name).

Restore, settings and tokens are not offered as tools.

They answer in compact text, one line per item, or with `format: "json"` in full. A token can edit or delete
only the comments it wrote itself; person tags are created in the app (Labels page) and only used by the tools.

Client config (most clients use this shape; use the absolute node path that `install.sh` prints at the end):

```json
{
  "mcpServers": {
    "organizer": {
      "command": "/home/you/.nvm/versions/node/v24.21.0/bin/node",
      "args": ["/home/you/.local/lib/organizer/current/mcp/index.js"],
      "env": {
        "SLOPPANIZER_URL": "http://127.0.0.1:4711",
        "ORGANIZER_TOKEN_FILE": "/home/you/.local/share/organizer/mcp-token"
      }
    }
  }
}
```

Both env values above are the defaults and can be left out. If organizer is not running, every tool answers
"organizer is not reachable at ... Start it: systemctl --user start organizer".

To replace the token: delete `~/.local/share/organizer/mcp-token`, rerun `deploy/install.sh`, then revoke the
old token with `DELETE /api/v1/tokens/{id}` (API docs, browser session).

## Export

Settings, **Download export**, or `GET /api/v1/export.zip` with a write token. The zip
(`organizer-export-YYYYMMDD-HHmmss.zip`, format 3) holds:

- `manifest.json`: format, versions, row counts per table, the attachments (count, bytes, ids of files that
  were missing on disk; a missing file does not stop the export) and the id counters, so a restore never hands
  out a todo number again.
- `data.json`: every table with its ids (no tokens, no secret, no search index), text exactly as stored. This is
  what a restore reads.
- `attachments/<id>-<name>`: every uploaded file.
- `todos/`, `notes/`, `people/`: one Markdown file each with YAML front matter (todos also carry their parent,
  links and repeat rule). Todos end with their comments,
  people list their topics, tags and the todos they requested or are a contact for. Links to uploads point into
  `attachments/`, so images show in any Markdown viewer.
- `README.md` explaining the layout.

The status bar turns amber when the last export is older than 7 days.

**Write to folder** (Settings, or `POST /api/v1/export/folder`, also with a write token, which the MCP tool
uses) saves the same zip in `~/.local/share/organizer/exports/` and keeps the newest 4 there; older ones are
deleted after each write. Copy that folder to another drive now and then.

### Restore

Settings, **Restore**: choose an export zip (format 1, 2 or 3, up to 1 GB, 4 GB unpacked). The file is checked
first and a preview compares what is in the file with what is there now; nothing changes until you type
`replace` and confirm. Before replacing, organizer saves a safety copy of the current data in
`~/.local/share/organizer/backups/` (the newest 5 are kept, downloadable from Settings). Everything is replaced:
todos, projects, labels, people, notes, comments and files. API tokens, the cookie secret (so this browser stays
signed in) and the export folder stay. A checked file waits for the confirm for one hour.

## Keyboard shortcuts

Off while typing in a field; the status bar then shows `insert`. Press `?` in the app for the full list.

| Keys | Action |
| --- | --- |
| `ctrl+k` | Command palette: pages, actions, todos by #id, and search over todos, notes, comments and people |
| `c` | New todo |
| `j` / `k` | Move down / up |
| `Enter` | Open the selected todo |
| `x` | Mark done / undone (with undo) |
| `e` | Edit the title |
| `l` / `p` / `r` | Labels / project / requested by |
| `1` to `4` | Priority critical, high, medium, low |
| `g n` / `g i` / `g l` / `g p` / `g s` | Go to Next up, Inbox, Labels, People, Settings |
| `g b` / `g w` / `g o` | Go to Board, Week, Notes |
| `g t` / `g m` / `g r` / `g c` | Go to Planner, Meetings, Recurring, Statistics |
| `n` | New note |
| `/` | Search page |
| `o` / `m` | On a todo: contacts / write a comment (`ctrl+Enter` sends) |
| `s` / `b` / `shift+r` / `u` | On a todo: add a subtask / add a link / repeat / go to the parent |
| `alt+j` / `alt+k` | On a todo: move the selected subtask down / up |
| `a` | API tokens: new token (`j` / `k` move, also on People statistics) |
| `h` / `l`, `j` / `k` | Board and week: between columns, inside a column |
| `shift+h` / `shift+l` | Board: move the todo one column left / right. Week: plan it a day earlier / later |
| `Backspace` | Week: unplan the selected todo |
| `[` / `]` / `t` | Week: previous, next, this week |
| `e` / `t` / `l` | On a person: edit name, topics, tags |
| `?` | Help |
| `Esc` | Close |

## Develop

```sh
corepack enable && pnpm install
ORGANIZER_PORT=4802 ORGANIZER_DATA_DIR=/tmp/organizer-dev pnpm dev
```

`pnpm dev` runs the server (port from `ORGANIZER_PORT`) and Vite on <http://localhost:5181>, which proxies `/api`
to that server. Use a port other than 4711 and a separate data dir so the installed service keeps running.

| Command | What it does |
| --- | --- |
| `pnpm check` | Lint, typecheck and tests of every package |
| `pnpm build` | Builds shared, web and the MCP bundle |
| `pnpm format` | Formats the code (oxfmt) |
| `pnpm --filter @organizer/<server\|web\|mcp\|shared> <script>` | One package |
| `pnpm --filter @organizer/server db:generate` | New migration after editing `apps/server/src/db/schema.ts` |
| `pnpm --filter @organizer/web test:e2e` | Browser tests of the main flows (todos, thread, notes, board, week, contacts, search, export, subtasks, checklists, links, repeats, tokens, people statistics, label conflicts, folder export, restore) on the built app, against a throwaway server on port 4804 (run `pnpm build` first; `npx playwright install chromium` once). `E2E_BASE_URL=http://organizer.localhost:4711` runs it against the installed service; it deletes what it creates, except uploaded files and folder export zips, and skips the restore step there |
| `bash deploy/test-install.sh` | Tests `install.sh` in a temp HOME with stand-ins for pnpm and systemctl |

Layout: `packages/shared` (API contract as zod schemas, Next up scoring), `apps/server` (Fastify, SQLite with
Drizzle migrations), `apps/web` (React, Vite), `apps/mcp` (MCP server), `deploy/` (service template, install).
Commits follow Conventional Commits (checked on commit).

## Releases

Every release has a version `major.minor.patch`, set once for the whole repo and listed in
[CHANGELOG.md](CHANGELOG.md). New entries go under "Unreleased" with each change. To cut a release on `dev`:

```sh
pnpm release 1.4.0          # changelog, every package.json, commit "chore(release): v1.4.0", tag v1.4.0
git push --follow-tags
```

Merging `dev` into `main` then ships it: CI builds the server image with the version and commit
(`ghcr.io/omeldar/sloppanizer:1.4.0`, `:latest` and `:<commit>`), and the web build carries the same version
(status bar; hover shows the commit). `GET /api/v1/health` answers `{ ok, version }` and nothing more.

The web app compares its version with the server's (at start, on returning to the tab, every minute while they
differ, otherwise every 15 minutes). While the server runs an older minor release than the web app (Watchtower
has not pulled the new image yet), a banner says "Sloppanizer is updating" and errors of new features read "in
a few minutes"; it goes away by itself. When the server is newer than an open tab, the banner offers Reload.
Bump the minor version when the web app needs something new from the server, the patch version for fixes; if a
fix release of the web app needs that same fix on the server, set `MIN_SERVER_VERSION` in
`apps/web/src/lib/serverVersion.ts`.

## Troubleshooting

- **The page does not load.** `systemctl --user status organizer`, then `journalctl --user -u organizer -n 50`.
  `curl -s http://127.0.0.1:4711/api/v1/health` should print `{"ok":true,...}`.
- **The service does not start, "address already in use".** Something else uses the port:
  `ss -ltnp | grep 4711`. Stop it, or install on another port with `ORGANIZER_PORT=4712 deploy/install.sh`.
- **"systemd user session is not available".** On WSL add `[boot]` `systemd=true` to `/etc/wsl.conf`, run
  `wsl --shutdown` in Windows, open a new terminal and rerun the install.
- **`organizer.localhost` does not resolve.** Chrome, Edge and Firefox send every `*.localhost` name to your own
  machine without any setup; other tools may not. Use <http://localhost:4711> there. On WSL, if Windows cannot
  reach it at all, check that `localhostForwarding` is not turned off in `.wslconfig`.
- **421 unknown host.** The host name in the URL is not in `ORGANIZER_ALLOWED_HOSTS`. Use one of the defaults.
- **The MCP server says the token was not accepted.** The token was revoked or the data dir changed: delete
  `~/.local/share/organizer/mcp-token` and rerun `deploy/install.sh`.
- **After an update something is broken.** Point `current` back at the previous release and restart:
  `ln -sfn ~/.local/lib/organizer/releases/<previous> ~/.local/lib/organizer/current && systemctl --user restart organizer`.
