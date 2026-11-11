#!/usr/bin/env bash
# Installs or updates organizer for the current user: builds the checkout, copies a self-contained
# release to ~/.local/lib/organizer/releases/<timestamp>/, points ~/.local/lib/organizer/current at it,
# writes and restarts the systemd user service and rolls back when the new release is not healthy.
# Safe to rerun: every run is an update.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: deploy/install.sh [--token-name NAME] [--dry-run]

  --token-name NAME  Name of the API token for MCP clients (default: assistant). Changes made through
                     the MCP server show this name as the actor. Only used when the token file is missing.
  --dry-run          Print what would happen, change nothing.

Environment (optional): ORGANIZER_PORT (default 4711), ORGANIZER_HEALTH_WAIT (seconds, default 30).
USAGE
}

TOKEN_NAME="assistant"
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --token-name)
      [ $# -ge 2 ] && [ -n "$2" ] || { echo "--token-name needs a name" >&2; exit 2; }
      TOKEN_NAME="$2"
      shift 2
      ;;
    --token-name=*)
      TOKEN_NAME="${1#*=}"
      [ -n "$TOKEN_NAME" ] || { echo "--token-name needs a name" >&2; exit 2; }
      shift
      ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${ORGANIZER_PORT:-4711}"
PREFIX="$HOME/.local/lib/organizer"
RELEASES="$PREFIX/releases"
CURRENT="$PREFIX/current"
DATA_DIR="$HOME/.local/share/organizer"
TOKEN_FILE="$DATA_DIR/mcp-token"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/organizer.service"
KEEP_RELEASES=3
HEALTH_URL="http://127.0.0.1:$PORT/api/v1/health"
APP_URL="http://organizer.localhost:$PORT"

say() { printf '%s\n' "$*"; }
fail() { printf 'install: %s\n' "$*" >&2; exit 1; }

# Runs a command, or only prints it in dry-run mode.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '+ %s\n' "$*"
  else
    "$@"
  fi
}

# ---------- checks ----------

command -v node >/dev/null || fail "node is not on PATH. Install Node 24 (e.g. nvm install 24) and rerun."
command -v pnpm >/dev/null || fail "pnpm is not on PATH. Enable it with: corepack enable"
# The service must not depend on nvm's shell setup: use the resolved binary.
NODE="$(readlink -f "$(command -v node)")"
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" = 24 ] || fail "organizer needs Node 24, found $("$NODE" --version) at $NODE."
if [ "$DRY_RUN" = 0 ]; then
  systemctl --user show-environment >/dev/null 2>&1 ||
    fail "the systemd user session is not available. On WSL set systemd=true in /etc/wsl.conf, run 'wsl --shutdown' in Windows and rerun."
fi

health_ok() {
  "$NODE" -e '
    fetch(process.argv[1], { signal: AbortSignal.timeout(2000) })
      .then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1));
  ' "$HEALTH_URL"
}

wait_healthy() {
  local tries=0 max=$((${ORGANIZER_HEALTH_WAIT:-30} * 2))
  while [ $tries -lt $max ]; do
    health_ok && return 0
    sleep 0.5
    tries=$((tries + 1))
  done
  return 1
}

# ---------- build ----------

say "Building $REPO"
run pnpm -C "$REPO" install --frozen-lockfile
run pnpm -C "$REPO" build

# ---------- release ----------

STAMP="$(date +%Y%m%d-%H%M%S)"
REL="$RELEASES/$STAMP"
n=2
while [ -e "$REL" ]; do REL="$RELEASES/$STAMP-$n"; n=$((n + 1)); done
PREVIOUS="$(readlink "$CURRENT" 2>/dev/null || true)"

say "Creating release $REL"
run mkdir -p "$REL"
# Until the switch, a failed step leaves no half-built release behind.
SWITCHED=0
trap '[ "$SWITCHED" = 1 ] || [ "$DRY_RUN" = 1 ] || rm -rf "$REL"' EXIT
# The server with production dependencies. Deploy into a staging folder, then copy: the copy breaks
# hard links into the checkout and the package store, so later builds there cannot change the release.
if ! run pnpm -C "$REPO" --filter @organizer/server deploy --prod "$REL/.staging-server"; then
  say "Retrying with the legacy deploy"
  run rm -rf "$REL/.staging-server"
  run pnpm -C "$REPO" --filter @organizer/server deploy --prod --legacy "$REL/.staging-server"
fi
run cp -a "$REL/.staging-server" "$REL/server"
run rm -rf "$REL/.staging-server"
run cp -a "$REPO/apps/web/dist" "$REL/web"
run mkdir -p "$REL/mcp"
run cp "$REPO/apps/mcp/dist/index.js" "$REL/mcp/index.js"
if [ "$DRY_RUN" = 0 ]; then
  printf '{ "type": "module" }\n' >"$REL/mcp/package.json"
  {
    printf 'commit %s\n' "$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"
    printf 'built %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } >"$REL/RELEASE"
fi

# Node does not strip types under node_modules, so @organizer/shared must point at its built dist.
fix_shared() {
  (cd "$REL/server" && "$NODE" --input-type=module -e '
    import { readFileSync, realpathSync, writeFileSync } from "node:fs";
    const root = realpathSync(".");
    const dir = realpathSync("node_modules/@organizer/shared");
    if (!dir.startsWith(root + "/")) {
      console.error(`@organizer/shared points outside the release: ${dir}`);
      process.exit(1);
    }
    const file = `${dir}/package.json`;
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    if (pkg.publishConfig?.exports) {
      pkg.exports = pkg.publishConfig.exports;
      delete pkg.publishConfig;
      writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
    }
  ')
}

# The release must not reach into the checkout (or anywhere else) through a symlink.
check_links() {
  local link target bad=0 root
  root="$(readlink -f "$REL")"
  while IFS= read -r -d '' link; do
    target="$(readlink -f "$link" || true)"
    case "$target" in
      "$root"/.staging-server/* | "$root"/.staging-server) bad=1 ;;
      "$root"/*) [ -e "$link" ] || bad=1 ;;
      *) bad=1 ;;
    esac
    [ $bad = 0 ] || { printf 'install: %s links outside the release or to nothing (%s)\n' "$link" "$target" >&2; return 1; }
  done < <(find "$REL" -type l -print0)
  return $bad
}

check_imports() {
  (cd "$REL/server" && "$NODE" --input-type=module -e '
    await import("@organizer/shared");
    const { default: Database } = await import("better-sqlite3");
    new Database(":memory:").close();
  ')
}

if [ "$DRY_RUN" = 0 ]; then
  if ! fix_shared || ! check_links || ! check_imports; then
    rm -rf "$REL"
    fail "the new release is not self-contained; nothing was switched. See the messages above."
  fi
fi

# ---------- switch ----------

switch_to() {
  run ln -sfn "$1" "$CURRENT.new"
  run mv -T "$CURRENT.new" "$CURRENT"
}

say "Switching $CURRENT to $(basename "$REL")"
switch_to "$REL"
SWITCHED=1

say "Writing $UNIT_FILE"
run mkdir -p "$UNIT_DIR"
if [ "$DRY_RUN" = 0 ]; then
  sed -e "s|@NODE@|$NODE|g" -e "s|@CURRENT@|$CURRENT|g" -e "s|@PORT@|$PORT|g" \
    "$REPO/deploy/organizer.service" >"$UNIT_FILE.new"
  mv "$UNIT_FILE.new" "$UNIT_FILE"
fi
run systemctl --user daemon-reload
run systemctl --user enable --quiet organizer
run systemctl --user restart organizer

if [ "$DRY_RUN" = 0 ]; then
  say "Waiting for $HEALTH_URL"
  if ! wait_healthy; then
    if [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ]; then
      say "The new release did not get healthy; rolling back to $(basename "$PREVIOUS")"
      switch_to "$PREVIOUS"
      systemctl --user restart organizer || true
      wait_healthy || say "The previous release does not answer either."
    fi
    rm -rf "$REL"
    fail "organizer did not answer on $HEALTH_URL. See: journalctl --user -u organizer -n 50"
  fi
else
  say "+ wait for $HEALTH_URL (roll back to ${PREVIOUS:-nothing} if it fails)"
fi

# ---------- clean up old releases ----------

if [ -d "$RELEASES" ]; then
  active="$(readlink -f "$CURRENT" 2>/dev/null || true)"
  # Keep the active release and the newest others, KEEP_RELEASES in total.
  kept=1
  while IFS= read -r name; do
    dir="$RELEASES/$name"
    [ "$dir" = "$active" ] && continue
    if [ $kept -lt $KEEP_RELEASES ]; then
      kept=$((kept + 1))
      continue
    fi
    say "Removing old release $name"
    run rm -rf "$dir"
  done < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -rV)
fi

# ---------- MCP token ----------

if [ -f "$TOKEN_FILE" ]; then
  say "Keeping the MCP token in $TOKEN_FILE"
  run chmod 600 "$TOKEN_FILE"
else
  say "Creating the MCP token \"$TOKEN_NAME\" in $TOKEN_FILE"
  run mkdir -p -m 700 "$DATA_DIR"
  run env ORGANIZER_DATA_DIR="$DATA_DIR" NODE_ENV=production \
    "$NODE" "$CURRENT/server/src/cli/token-create.ts" --name "$TOKEN_NAME" --scope write --out "$TOKEN_FILE"
  run chmod 600 "$TOKEN_FILE"
fi

# ---------- Windows Start menu shortcut (WSL only) ----------

start_menu_dir() {
  if [ -n "${ORGANIZER_STARTMENU_DIR:-}" ]; then
    printf '%s\n' "$ORGANIZER_STARTMENU_DIR"
    return 0
  fi
  grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null || return 1
  command -v cmd.exe >/dev/null && command -v wslpath >/dev/null || return 1
  local appdata
  appdata="$(cd /mnt/c 2>/dev/null && cmd.exe /c 'echo %APPDATA%' 2>/dev/null | tr -d '\r')" || return 1
  [ -n "$appdata" ] && [ "$appdata" != "%APPDATA%" ] || return 1
  printf '%s/Microsoft/Windows/Start Menu/Programs\n' "$(wslpath -u "$appdata")"
}

if menu="$(start_menu_dir)" && [ -d "$menu" ]; then
  shortcut="$menu/organizer.url"
  printf -v content '[InternetShortcut]\r\nURL=%s/\r\n' "$APP_URL"
  if [ ! -f "$shortcut" ] || [ "$(cat "$shortcut"; printf x)" != "${content}x" ]; then
    say "Writing the Start menu shortcut $shortcut"
    [ "$DRY_RUN" = 1 ] || printf '%s' "$content" >"$shortcut"
  fi
fi

say ""
say "organizer runs at $APP_URL (release $(basename "$REL"))."
say "MCP server for clients: $NODE $CURRENT/mcp/index.js (env ORGANIZER_TOKEN_FILE=$TOKEN_FILE)"
