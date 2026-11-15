#!/usr/bin/env bash
# Launches the REAL Tauri binary (src-tauri/target/release/leoposta, from
# `npx tauri build --no-bundle`) under Xvfb with a throwaway XDG_DATA_HOME, and
# checks the shell's lifecycle around its bundled node backend:
#
#   1. the backend starts on a random loopback port, the window opens
#      (stderr log + ss), the page's JS/CSS load with 200 for that origin
#   2. SIGTERM of the shell (session end) takes node down
#   3. SIGKILL of the shell (crash) still takes node down (PR_SET_PDEATHSIG)
#
# Never touches the real app-data dir; kills only PIDs it started.
#   tests/desktop/tauri-lifecycle.sh            (needs xvfb-run)
#   tests/desktop/tauri-lifecycle.sh --inner    (internal: runs inside Xvfb)
set -euo pipefail
cd "$(dirname "$0")/../.."
BIN="$PWD/src-tauri/target/release/leoposta"
[[ -x "$BIN" ]] || { echo "build it first: npx tauri build --no-bundle" >&2; exit 2; }

if [[ "${1:-}" != --inner ]]; then
  exec env -u WAYLAND_DISPLAY xvfb-run -a -s "-screen 0 1400x900x24" "$0" --inner
fi

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# launch <log> -> sets APP, NODE, PORT
launch() {
  XDG_DATA_HOME="$T/data" XDG_CONFIG_HOME="$T/config" XDG_CACHE_HOME="$T/cache" \
    WEBKIT_DISABLE_DMABUF_RENDERER=1 GDK_BACKEND=x11 \
    LEOPOSTA_GOA=off "$BIN" >"$T/$1" 2>&1 & # node inherits it: never the host's GNOME Online Accounts
  APP=$!
  for _ in $(seq 1 60); do grep -q 'window opened' "$T/$1" && break; sleep 0.5; done
  grep -q 'window opened' "$T/$1" || { cat "$T/$1"; fail "window never opened"; }
  NODE="$(grep -o 'node pid=[0-9]*' "$T/$1" | cut -d= -f2)"
  PORT="$(grep -o 'backend up on 127.0.0.1:[0-9]*' "$T/$1" | cut -d: -f2)"
  echo "launched: shell=$APP node=$NODE port=$PORT"
  grep -q "data dir = \"$T/data/org.schwier.leoposta\"" "$T/$1" || fail "app data dir is not the temp XDG_DATA_HOME"
  local listen; listen="$(ss -Htlnp "sport = :$PORT")"
  [[ "$listen" == *"pid=$NODE,"* ]] || fail "node $NODE is not listening on 127.0.0.1:$PORT: $listen"
  local js
  js="$(curl -fsS "http://127.0.0.1:$PORT/" | grep -o '/assets/index-[^"]*\.js' | head -1)"
  [[ "$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: http://127.0.0.1:$PORT" "http://127.0.0.1:$PORT$js")" == 200 ]] \
    || fail "the module script is refused for the window's own origin (blank window)"
}
gone() { # pid seconds
  for _ in $(seq 1 $(( $2 * 4 ))); do kill -0 "$1" 2>/dev/null || return 0; sleep 0.25; done
  return 1
}

# --- SIGTERM (logout / session end / `kill`) -----------------------------
launch run1.log
kill -TERM "$APP"
gone "$APP" 10 || { kill -KILL "$APP"; fail "app ignored SIGTERM"; }
gone "$NODE" 5 || { kill "$NODE"; fail "node $NODE orphaned after SIGTERM of the shell"; }
echo "ok: SIGTERM of the shell -> app exited, node gone"

# --- crash: SIGKILL the shell -------------------------------------------
launch run2.log
kill -KILL "$APP"
gone "$NODE" 5 || { kill "$NODE"; fail "node $NODE orphaned after SIGKILL of the shell"; }
echo "ok: SIGKILL of the shell -> node gone (PDEATHSIG)"
echo "PASS"
