# Open points for Eldar

Things Claude could not decide or do alone. Work continues on other things meanwhile.

- Release: `dev` holds finished packages; say "release" to merge them into `main` (that deploys). On `dev` now:
  1. Hosted MCP (`/api/v1/mcp`) with API token or OAuth sign-in (claude.ai connectors).
  2. Phone layout (drawer, tab bar, card rows, bottom sheets) and the softer design.
  3. Planner (time blocks), web links on todos, richer new todo (notes, links, plan day and time slot).
  4. Calendar feed (Settings): the planner in Google/Apple Calendar through a secret link.
  5. AI assistant (Settings, AI assistant): Plan my day and Suggest steps, on Claude or a local Ollama.
  The release runs four database migrations (OAuth, planner, calendar feed, AI settings); the server copies the database
  before it migrates. Checked 2026-11-14 on the VPS: the `dev` image started on a copy of the production data,
  applied all migrations, kept the todos and answered health 200 (copy deleted afterwards).
- After the next release: in claude.ai, Settings, Connectors, add a custom connector with
  `https://organizerapi.omeldar.cloud/api/v1/mcp` and sign in (works on the phone app too). Claude Code:
  `claude mcp add --transport http sloppanizer https://organizerapi.omeldar.cloud/api/v1/mcp`, then `/mcp` to sign in.
- AI assistant after the release: either add an Anthropic API key under Settings, AI assistant (Claude, works
  everywhere, small cost per request), or use the local model: set the Windows user environment variable
  `OLLAMA_ORIGINS=https://organizer.omeldar.com`, restart Ollama, pick "Local model" in Settings (the browser may
  ask to allow access to local devices).
- Local AI install runs in its own terminal tab ("Local AI setup", brief in `E:\AI\SETUP-TASK.md`); it may be
  waiting for your answers there.
