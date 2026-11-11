#!/usr/bin/env bash
# Tests deploy/install.sh without touching the real system: a temp HOME, a copy of the deploy files in
# a fake checkout, and stand-ins for pnpm (build and deploy) and systemctl (runs the unit's ExecStart).
# The stand-in server answers the health check on port 4803. Run: bash deploy/test-install.sh
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d /tmp/organizer-install-test.XXXXXX)"
export HOME="$T/home" FAKE_STATE="$T/state" ORGANIZER_PORT=4803 ORGANIZER_HEALTH_WAIT=5
export ORGANIZER_STARTMENU_DIR="$T/startmenu"
mkdir -p "$HOME" "$FAKE_STATE" "$ORGANIZER_STARTMENU_DIR" "$T/bin"
REPO="$T/repo"
INSTALL="$REPO/deploy/install.sh"
PREFIX="$HOME/.local/lib/organizer"

cleanup() {
  local status=$?
  if [ -f "$FAKE_STATE/pid" ]; then kill "$(cat "$FAKE_STATE/pid")" 2>/dev/null || true; fi
  if [ $status != 0 ]; then
    for out in "$T"/out*; do [ -f "$out" ] && { printf '\n--- %s\n' "$out"; tail -n 15 "$out"; }; done
  fi
  rm -rf "$T"
}
trap cleanup EXIT

# ---------- fake checkout ----------
mkdir -p "$REPO/deploy" "$REPO/apps/web/dist" "$REPO/apps/mcp/dist"
cp "$SRC/install.sh" "$SRC/organizer.service" "$REPO/deploy/"
echo '<!doctype html><title>organizer</title>' >"$REPO/apps/web/dist/index.html"
echo 'console.error("mcp")' >"$REPO/apps/mcp/dist/index.js"

# ---------- stand-ins ----------
cat >"$T/bin/pnpm" <<'PNPM'
#!/usr/bin/env bash
set -euo pipefail
echo "pnpm $*" >>"$FAKE_STATE/log"
case " $* " in
  *" deploy "*) ;;
  *) exit 0 ;;
esac
dir="${*: -1}"
[ "${FAKE_MODE:-}" != deploy-fails ] || { mkdir -p "$dir"; echo "deploy failed" >&2; exit 1; }
[ ! -e "$dir" ] || { echo "deploy target exists" >&2; exit 1; }
mkdir -p "$dir/src/cli" "$dir/node_modules/@organizer/shared/src" "$dir/node_modules/@organizer/shared/dist" \
  "$dir/node_modules/better-sqlite3"
echo '{ "type": "module" }' >"$dir/package.json"
if [ "${FAKE_MODE:-}" = broken ]; then
  echo 'process.exit(1);' >"$dir/src/index.ts"
else
  cat >"$dir/src/index.ts" <<'JS'
import { createServer } from "node:http";
const port: number = Number(process.env.ORGANIZER_PORT);
createServer((req, res) => {
  res.writeHead(req.url === "/api/v1/health" ? 200 : 404, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, version: "0.1.0", cwd: process.cwd(), env: process.env.NODE_ENV }));
}).listen(port, "127.0.0.1");
JS
fi
cat >"$dir/src/cli/token-create.ts" <<'JS'
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
const { values } = parseArgs({ options: { name: { type: "string" }, scope: { type: "string" }, out: { type: "string" } } });
writeFileSync(values.out!, `org_${"x".repeat(40)}\n`, { mode: 0o600 });
writeFileSync(`${process.env.FAKE_STATE}/token-args`, `${values.name} ${values.scope} ${process.env.ORGANIZER_DATA_DIR}\n`);
JS
sh="$dir/node_modules/@organizer/shared"
echo '{ "name": "@organizer/shared", "type": "module", "exports": { ".": "./src/index.ts" }, "publishConfig": { "exports": { ".": "./dist/index.js" } } }' >"$sh/package.json"
echo 'export const one: number = 1;' >"$sh/src/index.ts"
echo 'export const one = 1;' >"$sh/dist/index.js"
echo 'module.exports = function Database() { return { close() {} }; };' >"$dir/node_modules/better-sqlite3/index.js"
echo '{ "name": "better-sqlite3", "main": "index.js" }' >"$dir/node_modules/better-sqlite3/package.json"
if [ "${FAKE_MODE:-}" = link-out ]; then ln -s /tmp "$dir/node_modules/outside"; fi
PNPM

cat >"$T/bin/systemctl" <<'SYSTEMCTL'
#!/usr/bin/env bash
set -euo pipefail
echo "systemctl $*" >>"$FAKE_STATE/log"
[ "${2:-}" = restart ] || exit 0
unit="$HOME/.config/systemd/user/organizer.service"
if [ -f "$FAKE_STATE/pid" ]; then
  pid="$(cat "$FAKE_STATE/pid")"
  kill "$pid" 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null; do sleep 0.1; done
fi
workdir="$(sed -n 's/^WorkingDirectory=//p' "$unit")"
mapfile -t envs < <(sed -n 's/^Environment=//p' "$unit")
read -r -a cmd <<<"$(sed -n 's/^ExecStart=//p' "$unit")"
(cd "$workdir" && exec env "${envs[@]}" "${cmd[@]}") </dev/null >>"$FAKE_STATE/server.log" 2>&1 &
echo $! >"$FAKE_STATE/pid"
SYSTEMCTL
chmod +x "$T/bin/pnpm" "$T/bin/systemctl"
export PATH="$T/bin:$PATH"

# ---------- helpers ----------
failures=0
check() {
  local what="$1"
  shift
  if "$@"; then
    printf 'ok   %s\n' "$what"
  else
    printf 'FAIL %s\n' "$what"
    failures=$((failures + 1))
  fi
}
# Runs install.sh with the given arguments, output to $T/<name>.
run_install() {
  local name="$1"
  shift
  bash "$INSTALL" "$@" >"$T/$name" 2>&1
}
releases() { find "$PREFIX/releases" -mindepth 1 -maxdepth 1 -type d | wc -l; }
active() { basename "$(readlink -f "$PREFIX/current")"; }
snapshot() { find "$HOME" "$ORGANIZER_STARTMENU_DIR" -printf '%p %s %m %l\n' | sort; }
health() {
  node -e 'fetch(process.argv[1]).then(async (r) => { const b = await r.json(); process.exit(r.ok && b.env === "production" ? 0 : 1); }, () => process.exit(1))' \
    "http://127.0.0.1:$ORGANIZER_PORT/api/v1/health"
}

# ---------- 1. dry run on a fresh HOME changes nothing ----------
before="$(snapshot)"
out="$(bash "$INSTALL" --dry-run --token-name planner)"
check "dry run prints the build and deploy steps" grep -q -- "+ pnpm -C $REPO --filter @organizer/server deploy --prod" <<<"$out"
check "dry run prints the token step with the given name" grep -q -- "--name planner --scope write" <<<"$out"
check "dry run changes nothing" [ "$before" = "$(snapshot)" ]
check "dry run starts nothing" [ ! -f "$FAKE_STATE/pid" ]

# ---------- 2. first install ----------
check "first install succeeds" run_install out1 --token-name planner
first="$(active)"
check "current points at a release" [ -d "$PREFIX/releases/$first" ]
check "the server answers in production mode" health
unit="$HOME/.config/systemd/user/organizer.service"
check "unit uses the absolute node path" grep -qx "ExecStart=$(readlink -f "$(command -v node)") $PREFIX/current/server/src/index.ts" "$unit"
check "unit runs from current" grep -qx "WorkingDirectory=$PREFIX/current" "$unit"
check "unit has no placeholders left" bash -c "! grep -q '@[A-Z]*@' '$unit'"
check "unit is enabled and restarted" grep -q "systemctl --user enable --quiet organizer" "$FAKE_STATE/log"
check "token file is 0600" [ "$(stat -c %a "$HOME/.local/share/organizer/mcp-token")" = 600 ]
check "token is created with the given name in the data dir" \
  grep -qx "planner write $HOME/.local/share/organizer" "$FAKE_STATE/token-args"
check "shared points at its built dist" grep -q dist/index.js "$PREFIX/current/server/node_modules/@organizer/shared/package.json"
check "release has web, MCP bundle and module marker" \
  test -f "$PREFIX/current/web/index.html" -a -f "$PREFIX/current/mcp/index.js" -a -f "$PREFIX/current/mcp/package.json"
check "no staging folder is left" bash -c "! ls -d '$PREFIX'/releases/*/.staging-server 2>/dev/null"
check "Start menu shortcut points at the app" \
  [ "$(cat "$ORGANIZER_STARTMENU_DIR/organizer.url")" = "$(printf '[InternetShortcut]\r\nURL=http://organizer.localhost:4803/\r')" ]

# ---------- 3. rerun = update ----------
token_before="$(stat -c '%Y %s' "$HOME/.local/share/organizer/mcp-token")"
rm "$FAKE_STATE/token-args"
check "second install succeeds" run_install out2
second="$(active)"
check "a new release is active" [ "$second" != "$first" ]
check "the token file is kept" [ "$token_before" = "$(stat -c '%Y %s' "$HOME/.local/share/organizer/mcp-token")" ]
check "no new token is created" [ ! -f "$FAKE_STATE/token-args" ]
check "the shortcut is not rewritten" bash -c "! grep -q 'Start menu shortcut' '$T/out2'"
check "two releases exist" [ "$(releases)" = 2 ]

# ---------- 4. unhealthy release rolls back ----------
if FAKE_MODE=broken run_install out3; then status=0; else status=$?; fi
check "unhealthy install fails" [ "$status" != 0 ]
check "it says it rolls back" grep -q "rolling back to $second" "$T/out3"
check "current is back on the previous release" [ "$(active)" = "$second" ]
check "the failed release is removed" [ "$(releases)" = 2 ]
check "the previous release answers again" health

# ---------- 5. a release that links out of itself is refused ----------
if FAKE_MODE=link-out run_install out4; then status=0; else status=$?; fi
check "link-out install fails" [ "$status" != 0 ]
check "it names the link" grep -q "node_modules/outside links outside the release" "$T/out4"
check "nothing is switched" [ "$(active)" = "$second" ]
check "the refused release is removed" [ "$(releases)" = 2 ]

if FAKE_MODE=deploy-fails run_install out4b; then status=0; else status=$?; fi
check "a failed deploy step fails the install" [ "$status" != 0 ]
check "it tried the legacy deploy too" grep -q "Retrying with the legacy deploy" "$T/out4b"
check "no half-built release is left" [ "$(releases)" = 2 ]
check "current stays on the previous release" [ "$(active)" = "$second" ]

# ---------- 6. only the last three releases are kept ----------
check "third install succeeds" run_install out5
check "fourth install succeeds" run_install out6
check "three releases are kept" [ "$(releases)" = 3 ]
check "the oldest release is removed" [ ! -d "$PREFIX/releases/$first" ]
check "the two before the active one stay for rollback" [ -d "$PREFIX/releases/$second" ]

# ---------- 7. dry run on an installed system changes nothing ----------
before="$(snapshot)"
out="$(bash "$INSTALL" --dry-run 2>&1)" || { printf "dry run failed:\n%s\n" "$out"; exit 1; }
check "dry run names the rollback target" grep -q "roll back to $PREFIX/releases/$(active)" <<<"$out"
check "dry run keeps everything" [ "$before" = "$(snapshot)" ]

# ---------- 8. arguments ----------
if bash "$INSTALL" --token-name >/dev/null 2>&1; then status=0; else status=$?; fi
check "--token-name without a value is refused" [ "$status" = 2 ]
if bash "$INSTALL" --nope >/dev/null 2>&1; then status=0; else status=$?; fi
check "unknown options are refused" [ "$status" = 2 ]

if [ $failures -gt 0 ]; then
  printf '\n%d check(s) failed.\n' "$failures"
  exit 1
fi
printf '\nAll install checks passed.\n'
