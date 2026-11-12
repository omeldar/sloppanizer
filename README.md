# organizer

A personal todo and notes app that runs on your own machine. Todos live in projects or the Inbox, carry
labels (scoped ones like `priority::high` work like GitLab's: one per scope) and remember who asked for them
and whom to ask about them. **Next up** ranks the open todos by priority, due dates, plans, age and how long
they sat untouched, and tells you why each one is where it is.

- Every todo has a thread: comments in Markdown and a line for each change.
- Notes: Markdown pages, alone or in a project, pinned ones first.
- Paste or drop images and files into any Markdown field; images show inline, other files are downloads.
- Board (Open, In progress, Blocked, Done) and a week planner, both with drag and drop and keys.
- Search over todos, notes, comments and people (ignores case and accents), in the palette and on its own page.
- People and contacts: a small directory of colleagues with team, email, the topics they help with and your own
  tags, so "whom do I ask about firewall rules?" has an answer.

- Web app at <http://organizer.localhost:4711>, keyboard first.
- REST API under `/api/v1` with generated docs.
- An MCP server, so MCP clients can read and plan your todos.
- Everything stays local: one SQLite file, no network requests, no CDNs. Export to a zip any time.

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

Data lives in `~/.local/share/organizer/` (`organizer.db`, the cookie `secret`, `mcp-token`).

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
- Scripts authenticate with `Authorization: Bearer org_...`. Tokens are `read` (GET only) or `write`. Create one:

  ```sh
  ORGANIZER_DATA_DIR=~/.local/share/organizer \
    node ~/.local/lib/organizer/current/server/src/cli/token-create.ts --name scripts --scope read --out ~/organizer-read-token
  ```

  With `--out` the raw token goes into that file (0600) and is not printed. Tokens are managed under
  `/api/v1/tokens` from the browser session only.
- Uploads: `POST /api/v1/attachments?name=<file name>` with the raw file as the body (any type, up to 25 MB).
  The type is read from the file itself; PNG, JPEG, GIF and WebP show inline, everything else is served as a
  download. Files live in `~/.local/share/organizer/attachments/` and are part of the export.
- Search: `GET /api/v1/search?q=...` over todos, notes, comments and people.

## MCP server

A stdio MCP server for MCP clients, installed at `~/.local/lib/organizer/current/mcp/index.js`. It talks to the
running organizer through the REST API with the token from a file, so the token never sits in the client config.

Tools:

- Todos: `next_up`, `overview`, `list_todos`, `get_todo`, `create_todo`, `update_todo`, `bulk_update`,
  `mark_done`. Todos take requesters and contacts (people to ask) by id or by name.
- Thread: `get_activity` (changes and comments, one line each), `add_comment` (signed with the token's name).
- Notes: `list_notes`, `get_note`, `create_note`, `update_note` (with `appendText` to add to the end).
- People and contacts: `list_people` (filter by topic, team, tag or text: "whom do I ask about X"),
  `get_person`, `create_person`, `update_person`, `list_topics`, `list_person_tags`.
- Search: `search` over todos, notes, comments and people.
- Setup: `list_projects`, `create_project`, `list_labels`, `create_label`.

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
        "ORGANIZER_URL": "http://127.0.0.1:4711",
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
(`organizer-export-YYYYMMDD-HHmmss.zip`, format 2) holds:

- `manifest.json`: format, versions, row counts per table, and the attachments (count, bytes, ids of files that
  were missing on disk; a missing file does not stop the export).
- `data.json`: every table with its ids (no tokens, no secret, no search index), text exactly as stored. This is
  what a restore reads.
- `attachments/<id>-<name>`: every uploaded file.
- `todos/`, `notes/`, `people/`: one Markdown file each with YAML front matter. Todos end with their comments,
  people list their topics, tags and the todos they requested or are a contact for. Links to uploads point into
  `attachments/`, so images show in any Markdown viewer.
- `README.md` explaining the layout.

The status bar turns amber when the last export is older than 7 days.

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
| `n` | New note |
| `/` | Search page |
| `o` / `m` | On a todo: contacts / write a comment (`ctrl+Enter` sends) |
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
| `pnpm --filter @organizer/web test:e2e` | Browser tests of the main flows (todos, thread, notes, board, week, contacts, search, export) on the built app, against a throwaway server on port 4804 (run `pnpm build` first; `npx playwright install chromium` once). `E2E_BASE_URL=http://organizer.localhost:4711` runs it against the installed service; it deletes what it creates, except uploaded files (no delete for them yet) |
| `bash deploy/test-install.sh` | Tests `install.sh` in a temp HOME with stand-ins for pnpm and systemctl |

Layout: `packages/shared` (API contract as zod schemas, Next up scoring), `apps/server` (Fastify, SQLite with
Drizzle migrations), `apps/web` (React, Vite), `apps/mcp` (MCP server), `deploy/` (service template, install).
Commits follow Conventional Commits (checked on commit).

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
