# Open points for Eldar

Things Claude could not decide or do alone. Work continues on other things meanwhile.

- Release: `dev` holds finished packages; say "release" to merge them into `main` (that deploys). On `dev` now:
  1. Hosted MCP (`/api/v1/mcp`) with API token or OAuth sign-in (claude.ai connectors).
  2. Phone layout (drawer, tab bar, card rows, bottom sheets) and the softer design.
  3. Planner (time blocks), web links on todos, richer new todo (notes, links, plan day and time slot).
  The release runs two database migrations (OAuth, planner); the server copies the database before it migrates.
- After the next release: in claude.ai, Settings, Connectors, add a custom connector with
  `https://organizerapi.omeldar.cloud/api/v1/mcp` and sign in (works on the phone app too). Claude Code:
  `claude mcp add --transport http sloppanizer https://organizerapi.omeldar.cloud/api/v1/mcp`, then `/mcp` to sign in.
