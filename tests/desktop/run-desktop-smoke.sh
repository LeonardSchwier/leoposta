#!/usr/bin/env bash
# WebKitGTK smoke test of the desktop build, end to end:
#
#   1. build the desktop backend bundle exactly like the Tauri build does
#      (`npm run bundle:backend` -> src-tauri/resources/backend: node + server
#      + dist built with build:desktop)
#   2. bring up the real mail stack (tests/stack/stack.sh, Dovecot etc.)
#   3. self-test: start the bundled backend WITHOUT ALLOWED_ORIGINS (the
#      blank-white-window bug) and require tests/desktop/webkit-smoke.py to
#      FAIL on it, so we know the smoke can still see that class of bug
#   4. start the bundled backend the way src-tauri/src/lib.rs does (random
#      loopback port, HOST, ALLOWED_ORIGINS, temp LEOPOSTA_DATA_DIR, fresh
#      LEOPOSTA_TOKEN, cwd server/, LD_LIBRARY_PATH=libs), configure an account
#      on the stack with one seeded message, and require the smoke to PASS:
#      app up, folders listed, the message opens in the reading pane
#
#   tests/desktop/run-desktop-smoke.sh
#   SKIP_BUNDLE=1 ...      reuse an existing src-tauri/resources/backend
#   KEEP_STACK=1 ...       leave the stack running afterwards
#   SMOKE_DISPLAY=real ... use the current display instead of xvfb-run
#
# Uses E2E_STACK_ID like the e2e suite (ports + container names).
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"
BACKEND="$ROOT/src-tauri/resources/backend"
OUT="$ROOT/.e2e-real/desktop"

log() { echo "[desktop-smoke] $*"; }

if [[ -z "${SKIP_BUNDLE:-}" || ! -x "$BACKEND/node" ]]; then
  log "building the desktop bundle (npm run bundle:backend)"
  npm run --silent bundle:backend >/dev/null
fi
for f in node server/index.js dist/index.html; do
  [[ -e "$BACKEND/$f" ]] || { echo "missing $BACKEND/$f" >&2; exit 1; }
done

# Display: headless Xvfb when available (CI), otherwise the real session.
SMOKE=(python3 -I "$ROOT/tests/desktop/webkit-smoke.py")
# No GPU on CI / Xvfb, and WebKitGTK's DMA-BUF renderer needs one.
export WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_GPU=1
if [[ "${SMOKE_DISPLAY:-}" != real ]] && command -v xvfb-run >/dev/null; then
  SMOKE=(env -u WAYLAND_DISPLAY GDK_BACKEND=x11 xvfb-run -a -s "-screen 0 1600x1000x24" "${SMOKE[@]}")
  log "display: xvfb-run"
elif [[ -n "${WAYLAND_DISPLAY:-}${DISPLAY:-}" ]]; then
  log "display: current session (${WAYLAND_DISPLAY:-$DISPLAY})"
else
  echo "no display and no xvfb-run" >&2; exit 2
fi

BACKEND_PID=""
DATA_DIR=""
stop_backend() {
  if [[ -n "$BACKEND_PID" ]]; then
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
    BACKEND_PID=""
  fi
  [[ -z "$DATA_DIR" ]] || rm -rf "$DATA_DIR"
  DATA_DIR=""
}
cleanup() {
  stop_backend
  [[ -n "${KEEP_STACK:-}" ]] || tests/stack/stack.sh down >/dev/null
}
trap cleanup EXIT

free_port() { python3 -I -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }

# start_backend with-origins|without-origins|foreign-origin  -> sets PORT, TOKEN, BACKEND_PID
start_backend() {
  PORT="$(free_port)"
  TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  DATA_DIR="$(mktemp -d)"
  local env=(PORT="$PORT" HOST=127.0.0.1
             LD_LIBRARY_PATH="$BACKEND/libs${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
             LEOPOSTA_DATA_DIR="$DATA_DIR" LEOPOSTA_TOKEN="$TOKEN"
             LEOPOSTA_GOA=off) # never the host's real GNOME Online Accounts
  case "$1" in
    with-origins) env+=(ALLOWED_ORIGINS="http://127.0.0.1:$PORT") ;;
    # An origin list without the window's own origin: the white-screen
    # misconfiguration (the module script is answered 403).
    foreign-origin) env+=(ALLOWED_ORIGINS="http://127.0.0.1:1") ;;
    without-origins) ;;
  esac
  # Only what lib.rs sets: drop anything a dev shell may export that would
  # change what the bundle does (ALLOWED_ORIGINS in particular).
  (cd "$BACKEND/server" && exec env -u ALLOWED_ORIGINS -u LEOPOSTA_DIST_DIR "${env[@]}" "$BACKEND/node" "$BACKEND/server/index.js") \
    >"$OUT/backend-$1.log" 2>&1 &
  BACKEND_PID=$!
  for _ in $(seq 1 100); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      log "bundled backend pid=$BACKEND_PID on 127.0.0.1:$PORT ($1)"
      return 0
    fi
    kill -0 "$BACKEND_PID" 2>/dev/null || break
    sleep 0.2
  done
  cat "$OUT/backend-$1.log" >&2
  echo "bundled backend did not come up" >&2
  return 1
}

tests/stack/stack.sh up slash
mkdir -p "$OUT"

# --- 3. self-test: the original white-screen bug must be caught ------------
# Since the CORS fix (qa/security df6a08c) a backend without ALLOWED_ORIGINS
# trusts its own origin, so that alone no longer breaks the window; an origin
# list that leaves the window's origin out still does, and must be caught.
start_backend foreign-origin
set +e
"${SMOKE[@]}" "http://127.0.0.1:$PORT/" --token "$TOKEN" --timeout 20 >"$OUT/selftest.log" 2>&1
st=$?
set -e
stop_backend
if [[ $st -ne 1 ]] || ! grep -q 'resource: <script' "$OUT/selftest.log"; then
  cat "$OUT/selftest.log" >&2
  echo "SELF-TEST FAILED: the smoke did not catch the 403'd module script (exit $st)" >&2
  exit 1
fi
log "self-test ok: with a foreign ALLOWED_ORIGINS the smoke fails as it must:"
grep -E '^\s+(resource|failure|api):' "$OUT/selftest.log" | head -5 | sed 's/^/    /'

# Without ALLOWED_ORIGINS the backend's own origin is trusted: the app loads.
start_backend without-origins
"${SMOKE[@]}" "http://127.0.0.1:$PORT/" --token "$TOKEN" --timeout 20 >"$OUT/no-origins.log" 2>&1 \
  || { cat "$OUT/no-origins.log" >&2; echo "without ALLOWED_ORIGINS the app did not load (own origin must be trusted by default)" >&2; exit 1; }
stop_backend
log "without ALLOWED_ORIGINS the app loads (own origin trusted by default)"

# --- 4. the real run --------------------------------------------------------
start_backend with-origins
SUBJECT="Desktop smoke $(date +%s)"
BODY="Hello from the WebKitGTK smoke test."
ACCOUNT="$(node tests/desktop/seed-account.mjs "http://127.0.0.1:$PORT" "$TOKEN" "$SUBJECT" "$BODY")"
log "account: $ACCOUNT"
"${SMOKE[@]}" "http://127.0.0.1:$PORT/" --token "$TOKEN" \
  --click-text "$SUBJECT" --expect-text "$BODY" \
  --screenshot "$OUT/desktop-webkit.png"
log "PASS"
