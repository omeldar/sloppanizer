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
