# Open points for Eldar

Things Claude could not decide or do alone. Work continues on other things meanwhile.

- Released 2026-11-14 (hosted MCP, phone layout, planner, calendar feed, AI assistant). Vercel did not build
  the push to `main` by itself (the project shows no Git link); Claude started the production deploy through the
  Vercel API. Optional: connect the repo under Vercel, Project, Settings, Git so pushes to `main` deploy again.
- MCP: in claude.ai, Settings, Connectors, add a custom connector with
  `https://organizerapi.omeldar.cloud/api/v1/mcp` and sign in (works on the phone app too). Claude Code:
  `claude mcp add --transport http sloppanizer https://organizerapi.omeldar.cloud/api/v1/mcp`, then `/mcp` to sign in.
- AI assistant: either add an Anthropic API key under Settings, AI assistant (Claude, works
  everywhere, small cost per request), or use the local model: set the Windows user environment variable
  `OLLAMA_ORIGINS=https://organizer.omeldar.com`, restart Ollama, pick "Local model" in Settings (the browser may
  ask to allow access to local devices).
- Local AI install runs in its own terminal tab ("Local AI setup", brief in `E:\AI\SETUP-TASK.md`); it may be
  waiting for your answers there.
