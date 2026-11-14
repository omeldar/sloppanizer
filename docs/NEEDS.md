# Open points for Eldar

Things Claude could not decide or do alone. Work continues on other things meanwhile.

- Release: `dev` holds finished packages; say "release" to merge them into `main` (that deploys).
- After the next release: in claude.ai, Settings, Connectors, add a custom connector with
  `https://organizerapi.omeldar.cloud/api/v1/mcp` and sign in (works on the phone app too). Claude Code:
  `claude mcp add --transport http sloppanizer https://organizerapi.omeldar.cloud/api/v1/mcp`, then `/mcp` to sign in.
